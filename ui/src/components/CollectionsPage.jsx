import {useEffect, useState} from "react";
import {
  AlertDialog,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Dialog,
  Flex,
  IconButton,
  Link,
  Table,
  Text,
  TextField,
} from "@radix-ui/themes";
import {PlusIcon, TrashIcon} from "@radix-ui/react-icons";
import {COLLECTION_API_BASE, apiFetch} from "../lib/api";
import {ROLE_ADMIN, useSession} from "../lib/session";
import PageHeading from "./PageHeading";

// The root collection caches a thumbnail per collection precisely so a UI like
// this one does not have to open every leaf. Prefer the image service (a square
// crop is then free) and fall back to the cached derivative URL.
function collectionThumbnailUrl(thumbnail, size = 48) {
  const first = Array.isArray(thumbnail) ? thumbnail[0] : null;
  if (!first) return null;
  const service = Array.isArray(first.service) ? first.service[0] : first.service;
  const serviceId = service?.id || service?.["@id"];
  if (serviceId) {
    return `${serviceId.replace(/\/$/, "")}/square/${size},${size}/0/default.jpg`;
  }
  return first.id || null;
}

// .../presentation/collection/{slug}/collection.json
function slugFromCollectionId(id) {
  const match = /\/collection\/([^/]+)\/collection\.json$/.exec(id || "");
  return match ? match[1] : null;
}

function hideOnError(event) {
  event.currentTarget.style.visibility = "hidden";
}

// Matches the Add dialog on Works: one field, same buttons, same size.
function AddCollectionDialog({open, onOpenChange, onCreate}) {
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    const name = label.trim();
    if (!name) {
      setError("A name is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onCreate(name);
      setLabel("");
      onOpenChange(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setLabel("");
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <Dialog.Content maxWidth="calc(560 * var(--px))">
        <Dialog.Title>Add Collection</Dialog.Title>
        <form onSubmit={submit}>
          <Flex direction="column" gap="3">
            <label>
              <Text as="div" size="2" weight="medium" mb="1">
                Name
              </Text>
              <TextField.Root
                autoFocus
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="e.g. Environmental Impact Statements"
              />
              <Text as="div" size="1" color="gray" mt="1">
                Its id is derived from the name — &ldquo;Environmental Impact Statements&rdquo;
                becomes <code>environmental-impact-statements</code>. The name can&rsquo;t be
                changed later.
              </Text>
            </label>
            {error && (
              <Callout.Root color="red" size="1">
                <Callout.Text>{error}</Callout.Text>
              </Callout.Root>
            )}
            <Flex justify="end" gap="3" mt="2">
              <Dialog.Close>
                <Button type="button" variant="soft" color="gray" disabled={submitting}>
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" loading={submitting}>
                Create
              </Button>
            </Flex>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function CollectionRow({collection, isRoot = false, canDelete = false, onDelete}) {
  const thumbnail = collectionThumbnailUrl(collection.thumbnail);
  return (
    <Table.Row className={isRoot ? "collection-row--root" : undefined}>
      <Table.RowHeaderCell>
        <Flex align="center" gap="3">
          <span className="collection-thumb">
            {thumbnail && <img src={thumbnail} alt="" loading="lazy" onError={hideOnError} />}
          </span>
          <Text weight={isRoot ? "bold" : "medium"}>{collection.label}</Text>
          {isRoot && (
            <Badge size="1" variant="soft" color="gray" radius="full">
              Root
            </Badge>
          )}
        </Flex>
      </Table.RowHeaderCell>
      <Table.Cell>
        <Badge size="1" variant="soft" radius="full" className="collection-slug">
          {collection.slug}
        </Badge>
      </Table.Cell>
      <Table.Cell>
        <Text size="2">{collection.itemCount ?? "—"}</Text>
      </Table.Cell>
      <Table.Cell>
        <Flex align="center" justify="between" gap="3">
          <Link href={collection.id} target="_blank" rel="noreferrer" size="2">
            collection.json
          </Link>
          {canDelete && (
            <AlertDialog.Root>
              <AlertDialog.Trigger>
                <IconButton size="1" variant="ghost" color="red" aria-label={`Delete ${collection.label}`}>
                  <TrashIcon />
                </IconButton>
              </AlertDialog.Trigger>
              <AlertDialog.Content maxWidth="calc(480 * var(--px))">
                <AlertDialog.Title>Delete {collection.label}?</AlertDialog.Title>
                <AlertDialog.Description size="2">
                  This removes the collection and its IIIF document. It holds no works, so nothing
                  else is affected.
                </AlertDialog.Description>
                <Flex gap="3" mt="4" justify="end">
                  <AlertDialog.Cancel>
                    <Button variant="soft" color="gray">
                      Cancel
                    </Button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action>
                    <Button color="red" onClick={() => onDelete(collection)}>
                      Delete
                    </Button>
                  </AlertDialog.Action>
                </Flex>
              </AlertDialog.Content>
            </AlertDialog.Root>
          )}
        </Flex>
      </Table.Cell>
    </Table.Row>
  );
}

// Stub. Read-only for now: it proves the projection the works screen writes is
// queryable on its own, and gives the management features somewhere to land.
export default function CollectionsPage() {
  const session = useSession();
  // Same scoping as the works list: no admin role and no grant means the API
  // returns an empty set, which should read as "no access", not "none exist".
  const noAccess = session.role !== ROLE_ADMIN && session.collections.length === 0;
  const available = Boolean(COLLECTION_API_BASE);
  const [collections, setCollections] = useState([]);
  const [root, setRoot] = useState(null);
  const [loading, setLoading] = useState(available);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const isAdmin = session.role === ROLE_ADMIN;

  useEffect(() => {
    if (!available) return undefined;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const data = await apiFetch(COLLECTION_API_BASE, {errorMessage: "Unable to load collections"});
        if (cancelled) return;
        setCollections(Array.isArray(data.collections) ? data.collections : []);
        setRoot(data.root || null);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [available]);

  const handleCreate = async (label) => {
    const data = await apiFetch(COLLECTION_API_BASE, {
      method: "POST",
      body: {label},
      errorMessage: "Unable to create collection",
    });
    // The API returns the whole list back, so the table never has to refetch.
    if (Array.isArray(data.collections)) setCollections(data.collections);
    setError(null);
  };

  const handleDelete = async (collection) => {
    try {
      const data = await apiFetch(`${COLLECTION_API_BASE}/${encodeURIComponent(collection.slug)}`, {
        method: "DELETE",
        errorMessage: "Unable to delete collection",
      });
      if (Array.isArray(data.collections)) setCollections(data.collections);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };

  // The collection of collections. Its members are the collections below it, so
  // its count is their number — not a sum of theirs, which would double-count a
  // work that belongs to two.
  const rootRow = root?.id
    ? {
        label: root.label || "All Collections",
        slug: slugFromCollectionId(root.id) || "index",
        id: root.id,
        itemCount: collections.length,
        thumbnail: null,
      }
    : null;

  return (
    <Flex direction="column" gap="5">
      <PageHeading>Collections</PageHeading>
      <Card size="3" className="panel">
        {isAdmin && (
          <Flex justify="end" align="center" gap="3" mb="4">
            <Button type="button" size="3" onClick={() => setAdding(true)} disabled={!available}>
              <PlusIcon /> Add
            </Button>
          </Flex>
        )}
        <Box className="panel-body">
          {!available && (
            <Callout.Root color="red" size="1" mb="3">
              <Callout.Text>
                Collection API URL is not configured. Update VITE_COLLECTION_API_URL to point at the
                deployed endpoint.
              </Callout.Text>
            </Callout.Root>
          )}
          {error && available && (
            <Callout.Root color="red" size="1" mb="3">
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          )}
          {loading ? (
            <Text as="p" size="2" color="gray">
              Loading collections…
            </Text>
          ) : !rootRow ? (
            <Text as="p" size="2" color="gray">
              No collections to show.
            </Text>
          ) : (
            <Table.Root size="2" variant="surface" className="manifest-list">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Collection</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Slug</Table.ColumnHeaderCell>
                  {/* "Items", not "Works": the root's members are collections. */}
                  <Table.ColumnHeaderCell>Items</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>IIIF</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                <CollectionRow collection={rootRow} isRoot />
                {collections.map((collection) => (
                  <CollectionRow
                    key={collection.slug}
                    collection={collection}
                    // Only an empty collection can be deleted; the API refuses
                    // the rest rather than cascading over every member.
                    canDelete={isAdmin && !collection.itemCount}
                    onDelete={handleDelete}
                  />
                ))}
                {collections.length === 0 && (
                  <Table.Row>
                    <Table.Cell colSpan={4}>
                      <Text as="p" size="2" color="gray">
                        {noAccess
                          ? "You haven't been granted access to any collections. An administrator can grant you access from the Users section."
                          : isAdmin
                            ? "No collections yet. Use Add to create one."
                            : "No collections yet."}
                      </Text>
                    </Table.Cell>
                  </Table.Row>
                )}
              </Table.Body>
            </Table.Root>
          )}
        </Box>
      </Card>
      <AddCollectionDialog open={adding} onOpenChange={setAdding} onCreate={handleCreate} />
    </Flex>
  );
}
