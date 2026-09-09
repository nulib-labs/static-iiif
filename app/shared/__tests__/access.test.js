const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ROLE_ADMIN,
  ROLE_EDITOR,
  COLLECTION_GROUP_PREFIX,
  collectionGroupName,
  collectionSlugFromGroup,
  parseGroupClaim,
  principalFromClaims,
  principalFromEvent,
  isAdmin,
  canManageUsers,
  canReindex,
  canEditWork,
  canCreateWork,
  canSetWorkCollections,
  changedSlugs,
  toSlugArray,
  normalizeRoles,
  canAssignRoles,
  visibleCollectionSlugs,
  canViewWork,
  canViewCollection,
} = require("../access");

const claims = (groups, rest = {}) => ({sub: "u-1", email: "u@example.edu", "cognito:groups": groups, ...rest});
const admin = principalFromClaims(claims([ROLE_ADMIN]));
const editor = principalFromClaims(claims([ROLE_EDITOR, collectionGroupName("eis")]));
const stranger = principalFromClaims(claims([]));

test("group names round-trip", () => {
  assert.equal(collectionGroupName("eis"), "collection:eis");
  assert.equal(collectionSlugFromGroup("collection:eis"), "eis");
  assert.equal(collectionSlugFromGroup("collection:environmental-impact-statements"), "environmental-impact-statements");
  // A hyphen separator would be ambiguous with slugs; a colon cannot appear in one.
  assert.equal(COLLECTION_GROUP_PREFIX, "collection:");
});

test("group names that are not grants resolve to nothing", () => {
  for (const name of [ROLE_ADMIN, ROLE_EDITOR, "collection:", "collections:eis", "", null, undefined, 42]) {
    assert.equal(collectionSlugFromGroup(name), null, `expected no slug from ${String(name)}`);
  }
});

// The HTTP API JWT authorizer serializes a multi-valued claim as "[a b]", not as
// JSON. Getting this wrong makes every group silently invisible.
test("parseGroupClaim accepts every shape the claim arrives in", () => {
  assert.deepEqual(parseGroupClaim(["admin", "collection:eis"]), ["admin", "collection:eis"]);
  assert.deepEqual(parseGroupClaim("[admin collection:eis]"), ["admin", "collection:eis"]);
  assert.deepEqual(parseGroupClaim("admin,collection:eis"), ["admin", "collection:eis"]);
  assert.deepEqual(parseGroupClaim("editor"), ["editor"]);
  for (const empty of ["", "   ", "[]", null, undefined, 7, {}]) {
    assert.deepEqual(parseGroupClaim(empty), [], `expected [] from ${JSON.stringify(empty)}`);
  }
});

test("admin wins when a user is in both role groups", () => {
  const both = principalFromClaims(claims([ROLE_EDITOR, ROLE_ADMIN]));
  assert.equal(both.role, ROLE_ADMIN);
  assert.ok(isAdmin(both));
});

test("a user in no group has no role and no grants", () => {
  assert.equal(stranger.role, null);
  assert.equal(stranger.collections.size, 0);
  assert.equal(canManageUsers(stranger), false);
  assert.equal(canEditWork(stranger, ["eis"]), false);
  assert.equal(canCreateWork(stranger, ["eis"]), false);
});

test("principalFromEvent reads the authorizer claims", () => {
  const principal = principalFromEvent({
    requestContext: {authorizer: {jwt: {claims: claims("[editor collection:bikes]")}}},
  });
  assert.equal(principal.role, ROLE_EDITOR);
  assert.deepEqual([...principal.collections], ["bikes"]);
  assert.equal(principal.email, "u@example.edu");
});

test("principalFromEvent on an event with no authorizer denies everything", () => {
  const principal = principalFromEvent({});
  assert.equal(principal.role, null);
  assert.equal(canManageUsers(principal), false);
  assert.equal(canEditWork(principal, ["eis"]), false);
});

// The check that stops a signed-in user promoting themselves.
test("only an admin manages users or reindexes", () => {
  assert.equal(canManageUsers(admin), true);
  assert.equal(canManageUsers(editor), false);
  assert.equal(canReindex(admin), true);
  assert.equal(canReindex(editor), false);
});

test("an editor edits only works in a collection they hold", () => {
  assert.equal(canEditWork(editor, ["eis"]), true);
  assert.equal(canEditWork(editor, ["eis", "bikes"]), true, "one held collection is enough");
  assert.equal(canEditWork(editor, ["bikes"]), false);
  assert.equal(canEditWork(editor, []), false, "an uncollected work is admin-only");
});

test("an admin edits anything, including uncollected works", () => {
  assert.equal(canEditWork(admin, []), true);
  assert.equal(canEditWork(admin, ["anything"]), true);
});

test("slugs are accepted as bare strings or as {slug} refs", () => {
  assert.deepEqual(toSlugArray(["eis", {slug: "bikes", label: "Bikes"}]), ["eis", "bikes"]);
  assert.deepEqual(toSlugArray([null, undefined, {}, 3, ""]), []);
  assert.deepEqual(toSlugArray("eis"), [], "a bare string is not a list");
  assert.equal(canEditWork(editor, [{slug: "eis", label: "EIS"}]), true);
});

test("an editor must file a new work into a collection they hold", () => {
  assert.equal(canCreateWork(editor, ["eis"]), true);
  assert.equal(canCreateWork(editor, []), false, "would create a work it cannot then edit");
  assert.equal(canCreateWork(editor, ["bikes"]), false);
  assert.equal(canCreateWork(editor, ["eis", "bikes"]), false, "every target must be held");
  assert.equal(canCreateWork(admin, []), true);
});

test("changedSlugs is the symmetric difference, sorted", () => {
  assert.deepEqual(changedSlugs(["eis"], ["eis"]), []);
  assert.deepEqual(changedSlugs(["eis"], []), ["eis"]);
  assert.deepEqual(changedSlugs([], ["eis"]), ["eis"]);
  assert.deepEqual(changedSlugs(["a", "b"], ["b", "c"]), ["a", "c"]);
});

test("an editor may only add or remove collections they hold", () => {
  assert.equal(canSetWorkCollections(editor, ["eis"], ["eis"]), true, "a no-op save");
  assert.equal(canSetWorkCollections(editor, ["eis"], []), true, "may drop their own collection");
  assert.equal(canSetWorkCollections(editor, ["eis"], ["eis", "bikes"]), false, "cannot file into another's");
  assert.equal(canSetWorkCollections(editor, ["bikes"], ["bikes", "eis"]), false, "cannot edit the work at all");
});

// An editor editing a work that also sits in someone else's collection must not
// be able to quietly evict it from there.
test("an editor cannot remove a collection they do not hold", () => {
  assert.equal(canSetWorkCollections(editor, ["eis", "bikes"], ["eis"]), false);
  assert.equal(canSetWorkCollections(editor, ["eis", "bikes"], ["eis", "bikes"]), true);
});

test("an admin may set any membership", () => {
  assert.equal(canSetWorkCollections(admin, ["a"], ["b", "c"]), true);
  assert.equal(canSetWorkCollections(admin, [], ["b"]), true);
});

// --- role assignment -------------------------------------------------------

test("normalizeRoles keeps real roles in a fixed order and drops the rest", () => {
  assert.deepEqual(normalizeRoles([ROLE_EDITOR, ROLE_ADMIN]), [ROLE_ADMIN, ROLE_EDITOR]);
  assert.deepEqual(normalizeRoles([ROLE_ADMIN, ROLE_EDITOR]), [ROLE_ADMIN, ROLE_EDITOR]);
  // "user" is the baseline the UI always shows checked; it is not a group.
  assert.deepEqual(normalizeRoles(["user"]), []);
  assert.deepEqual(normalizeRoles(["admin", "user", "collection:eis", "root"]), [ROLE_ADMIN]);
  for (const empty of [[], null, undefined, "admin", {}]) {
    assert.deepEqual(normalizeRoles(empty), [], `expected [] from ${JSON.stringify(empty)}`);
  }
});

test("a principal reports every role it holds, not just the effective one", () => {
  const both = principalFromClaims(claims([ROLE_EDITOR, ROLE_ADMIN]));
  assert.equal(both.role, ROLE_ADMIN, "effective role is still admin");
  assert.deepEqual(both.roles, [ROLE_ADMIN, ROLE_EDITOR]);
  assert.deepEqual(principalFromClaims(claims([])).roles, []);
});

// The rule that makes the pool un-lockable: the only way to reduce the admin
// count is one admin demoting another, which always leaves the caller behind.
test("an admin cannot remove their own admin role", () => {
  const self = principalFromClaims({...claims([ROLE_ADMIN]), sub: "me"});
  assert.equal(canAssignRoles(self, "me", []), false);
  assert.equal(canAssignRoles(self, "me", [ROLE_EDITOR]), false);
  assert.equal(canAssignRoles(self, "me", [ROLE_ADMIN]), true);
  assert.equal(canAssignRoles(self, "me", [ROLE_ADMIN, ROLE_EDITOR]), true, "may still add editor");
});

test("an admin may demote anyone else", () => {
  const self = principalFromClaims({...claims([ROLE_ADMIN]), sub: "me"});
  assert.equal(canAssignRoles(self, "someone-else", []), true);
  assert.equal(canAssignRoles(self, "someone-else", [ROLE_EDITOR]), true);
});

test("only an admin may assign roles at all", () => {
  const notAdmin = principalFromClaims({...claims([ROLE_EDITOR]), sub: "me"});
  assert.equal(canAssignRoles(notAdmin, "anyone", [ROLE_EDITOR]), false);
  assert.equal(canAssignRoles(notAdmin, "me", [ROLE_ADMIN]), false, "cannot self-promote");
  assert.equal(canAssignRoles(stranger, "anyone", []), false);
});

// A principal with no sub cannot be matched against a target, and must not
// accidentally pass the self-check.
test("a principal with no sub is not treated as anyone's self", () => {
  const noSub = principalFromClaims({"cognito:groups": [ROLE_ADMIN]});
  assert.equal(noSub.sub, null);
  assert.equal(canAssignRoles(noSub, "me", []), true, "no self match, so the guard does not apply");
});

// --- read scoping ----------------------------------------------------------

// A grant with no role is read-only sight of that collection. This is what
// makes "show someone a collection without letting them change it" expressible
// without a third role.
const viewer = principalFromClaims(claims([collectionGroupName("eis")]));

test("a user with no role and no grant sees nothing", () => {
  assert.equal(canViewWork(stranger, ["eis"]), false);
  assert.equal(canViewWork(stranger, []), false);
  assert.equal(canViewCollection(stranger, "eis"), false);
  assert.deepEqual(visibleCollectionSlugs(stranger), []);
});

test("an editor sees only the collections they hold", () => {
  assert.equal(canViewWork(editor, ["eis"]), true);
  assert.equal(canViewWork(editor, ["eis", "bikes"]), true);
  assert.equal(canViewWork(editor, ["bikes"]), false);
  assert.equal(canViewWork(editor, []), false, "an uncollected work is admin-only");
  assert.equal(canViewCollection(editor, "eis"), true);
  assert.equal(canViewCollection(editor, "bikes"), false);
  assert.deepEqual(visibleCollectionSlugs(editor), ["eis"]);
});

test("an admin is unrestricted, and that is signalled by null not a list", () => {
  assert.equal(canViewWork(admin, []), true);
  assert.equal(canViewWork(admin, ["anything"]), true);
  assert.equal(canViewCollection(admin, "anything"), true);
  assert.equal(visibleCollectionSlugs(admin), null, "null means no restriction, [] means nothing");
});

test("a grant without a role grants sight but not editing", () => {
  assert.equal(viewer.role, null);
  assert.equal(canViewWork(viewer, ["eis"]), true);
  assert.equal(canViewCollection(viewer, "eis"), true);
  assert.equal(canEditWork(viewer, ["eis"]), false, "reading is not editing");
  assert.equal(canCreateWork(viewer, ["eis"]), false);
  assert.deepEqual(visibleCollectionSlugs(viewer), ["eis"]);
});

test("view scoping accepts {slug} refs as well as bare slugs", () => {
  assert.equal(canViewWork(editor, [{slug: "eis", label: "EIS"}]), true);
  assert.equal(canViewWork(editor, [{slug: "bikes", label: "Bikes"}]), false);
});
