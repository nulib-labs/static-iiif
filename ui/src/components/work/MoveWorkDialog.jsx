import {useEffect, useState} from "react";
import {AlertDialog, Button, Callout, Flex, Select, Text} from "@radix-ui/themes";
import {COLLECTION_API_BASE, apiFetch} from "../../lib/api";
import {ROLE_ADMIN, useSession} from "../../lib/session";

// The vocabulary is fetched when the dialog opens, not on every work-page
// mount: this is the only thing that still needs it, and it is the rarest
// action on the page.
export default function MoveWorkDialog({open, currentSlug, onCancel, onMove}) {
  const session = useSession();
  const isAdmin = session.role === ROLE_ADMIN;
  const [collections, setCollections] = useState([]);
  const [loading, setLoading] = useState(false);
  const [target, setTarget] = useState(currentSlug || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || !COLLECTION_API_BASE) return undefined;
    let cancelled = false;
    setLoading(true);
    setTarget(currentSlug || "");
    setError(null);
    (async () => {
      try {
        const data = await apiFetch(COLLECTION_API_BASE, {errorMessage: "Unable to load collections"});
        if (!cancelled) setCollections(Array.isArray(data.collections) ? data.collections : []);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, currentSlug]);

  // An editor can only move a work into a collection they hold — the API
  // refuses otherwise, so offering the rest would only produce a 403.
  const options = isAdmin
    ? collections
    : collections.filter((entry) => session.collections.includes(entry.slug));

  const handleMove = async (event) => {
    event.preventDefault();
    if (!target || target === currentSlug) return;
    setSaving(true);
    setError(null);
    try {
      await onMove(collections.find((entry) => entry.slug === target)?.label || target);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialog.Content maxWidth="calc(480 * var(--px))">
        <AlertDialog.Title>Move to another collection</AlertDialog.Title>
        <AlertDialog.Description size="2">
          A work belongs to exactly one collection. Moving it removes it from its
          current one.
        </AlertDialog.Description>
        <Flex direction="column" gap="2" mt="4">
          {loading ? (
            <Text size="2" color="gray">Loading collections…</Text>
          ) : (
            <Select.Root value={target} onValueChange={setTarget}>
              <Select.Trigger placeholder="Choose a collection…" />
              <Select.Content>
                {options.map((entry) => (
                  <Select.Item key={entry.slug} value={entry.slug}>
                    {entry.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          )}
          {!loading && options.length === 0 && (
            <Text size="1" color="gray">
              There is nowhere to move this work to. An administrator creates
              collections on the Collections screen.
            </Text>
          )}
        </Flex>
        {error && (
          <Callout.Root color="red" size="1" mt="3">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}
        <Flex justify="end" gap="3" mt="4">
          <AlertDialog.Cancel>
            <Button type="button" variant="soft" color="gray" disabled={saving}>
              Cancel
            </Button>
          </AlertDialog.Cancel>
          <Button
            type="button"
            onClick={handleMove}
            loading={saving}
            disabled={!target || target === currentSlug}
          >
            Move
          </Button>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
