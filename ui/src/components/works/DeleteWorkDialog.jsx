import {useState} from "react";
import {AlertDialog, Button, Callout, Flex} from "@radix-ui/themes";

export default function DeleteWorkDialog({work, onCancel, onConfirm}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  const handleConfirm = async (event) => {
    event.preventDefault();
    if (!work) return;
    setDeleting(true);
    setError(null);
    try {
      await onConfirm(work.identifier);
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AlertDialog.Root
      open={Boolean(work)}
      onOpenChange={(open) => {
        if (!open) {
          setError(null);
          onCancel();
        }
      }}
    >
      <AlertDialog.Content maxWidth="calc(480 * var(--px))">
        <AlertDialog.Title>Delete work?</AlertDialog.Title>
        <AlertDialog.Description size="2">
          This permanently deletes “{work?.label || work?.identifier}”, its manifest,
          every source image and IIIF-generated derivative it references. This cannot be undone.
        </AlertDialog.Description>
        {error && (
          <Callout.Root color="red" size="1" mt="3">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}
        <Flex justify="end" gap="3" mt="4">
          <AlertDialog.Cancel>
            <Button type="button" variant="soft" color="gray" disabled={deleting}>
              Cancel
            </Button>
          </AlertDialog.Cancel>
          <Button type="button" color="red" onClick={handleConfirm} loading={deleting}>
            Delete
          </Button>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
