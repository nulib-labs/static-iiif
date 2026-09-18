import {
  Box,
  Button,
  Callout,
  Card,
  Dialog,
  Flex,
  Text,
  TextField,
} from "@radix-ui/themes";
import {suggestCollectionSlug, collectionSlugError} from "../../lib/collectionSlug";

// Two independent fields, shown by both branches.
//
// A collection has a name, which is a display string in any script and is free
// to change, and an id, which is permanent and public. The id is PREFILLED from
// the name and then left alone once the curator edits it. On the import branch
// the name simply arrives from the fetched collection instead of from
// keystrokes — the derivation is the same one, and it still lives here rather
// than on the server, because a server that derives one from the other makes
// the name into identity again.
function NameAndIdFields({form, onChange, disabled, namePlaceholder, idPlaceholder, autoFocus}) {
  const setLabel = (label) => {
    onChange(form.slugEdited ? {label} : {label, slug: suggestCollectionSlug(label)});
  };
  const problem = form.slug || form.slugEdited ? collectionSlugError(form.slug) : null;

  return (
    <>
      <label>
        <Text as="div" size="2" weight="medium" mb="1">
          Name
        </Text>
        <TextField.Root
          autoFocus={autoFocus}
          disabled={disabled}
          value={form.label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={namePlaceholder}
        />
        <Text as="div" size="1" color="gray" mt="1">
          Shown throughout the app. Any language.
        </Text>
      </label>
      <label>
        <Text as="div" size="2" weight="medium" mb="1">
          Id
        </Text>
        <TextField.Root
          disabled={disabled}
          value={form.slug}
          onChange={(event) => onChange({slug: event.target.value, slugEdited: true})}
          placeholder={idPlaceholder}
        />
        <Text as="div" size="1" color={problem ? "red" : "gray"} mt="1">
          {problem ||
            "Lowercase letters, numbers and dashes. Permanent — it is part of every URL this collection publishes, and no route can change it later."}
        </Text>
      </label>
    </>
  );
}

export default function AddCollectionModal({
  open,
  onClose,
  step,
  onSelectStep,
  onBack,
  createForm,
  onCreateChange,
  onCreateSubmit,
  createSubmitting,
  createError,
  importUrl,
  onImportUrlChange,
  onImportFetch,
  importFetching,
  importError,
  importPreview,
  importForm,
  onImportFormChange,
  onImportConfirm,
  importConfirming,
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Content maxWidth="calc(560 * var(--px))">
        {step === "choose" && (
          <>
            <Dialog.Title>Add Collection</Dialog.Title>
            <Flex direction="column" gap="3">
              <Card asChild variant="surface" className="add-work-option">
                <button type="button" onClick={() => onSelectStep("import-url")}>
                  <Flex direction="column" gap="1">
                    <Text weight="medium">Import Collection</Text>
                    <Text size="2" color="gray">
                      Bring in an existing IIIF Collection and every work in it.
                    </Text>
                  </Flex>
                </button>
              </Card>
              <Card asChild variant="surface" className="add-work-option">
                <button type="button" onClick={() => onSelectStep("create")}>
                  <Flex direction="column" gap="1">
                    <Text weight="medium">Create Collection</Text>
                    <Text size="2" color="gray">Manually create a new, empty collection.</Text>
                  </Flex>
                </button>
              </Card>
              <Flex justify="end" mt="2">
                <Button type="button" variant="soft" color="gray" onClick={onClose}>
                  Cancel
                </Button>
              </Flex>
            </Flex>
          </>
        )}

        {step === "create" && (
          <>
            <Dialog.Title>Create Collection</Dialog.Title>
            <form onSubmit={onCreateSubmit}>
              <Flex direction="column" gap="3">
                <NameAndIdFields
                  autoFocus
                  form={createForm}
                  onChange={onCreateChange}
                  disabled={createSubmitting}
                  namePlaceholder="e.g. Environmental Impact Statements"
                  idPlaceholder="e.g. environmental-impact-statements"
                />
                {createError && (
                  <Callout.Root color="red" size="1">
                    <Callout.Text>{createError}</Callout.Text>
                  </Callout.Root>
                )}
                <Flex justify="between" gap="3" mt="2">
                  <Button type="button" variant="ghost" onClick={onBack} disabled={createSubmitting}>
                    ← Back
                  </Button>
                  <Flex gap="3">
                    <Button type="button" variant="soft" color="gray" onClick={onClose} disabled={createSubmitting}>
                      Cancel
                    </Button>
                    <Button type="submit" loading={createSubmitting}>
                      Create
                    </Button>
                  </Flex>
                </Flex>
              </Flex>
            </form>
          </>
        )}

        {step === "import-url" && (
          <>
            <Dialog.Title>Import Collection</Dialog.Title>
            <form onSubmit={onImportFetch}>
              <Flex direction="column" gap="3">
                <label>
                  <Text as="div" size="2" weight="medium" mb="1">Collection URL</Text>
                  <TextField.Root
                    autoFocus
                    type="url"
                    required
                    value={importUrl}
                    onChange={(event) => onImportUrlChange(event.target.value)}
                    placeholder="https://example.org/iiif/collection.json"
                  />
                  <Text as="div" size="1" color="gray" mt="1">
                    A IIIF Presentation 3.0 Collection. Every Manifest in it is imported as a work.
                  </Text>
                </label>
                {importError && (
                  <Callout.Root color="red" size="1">
                    <Callout.Text>{importError}</Callout.Text>
                  </Callout.Root>
                )}
                <Flex justify="between" gap="3" mt="2">
                  <Button type="button" variant="ghost" onClick={onBack} disabled={importFetching}>
                    ← Back
                  </Button>
                  <Flex gap="3">
                    <Button type="button" variant="soft" color="gray" onClick={onClose} disabled={importFetching}>
                      Cancel
                    </Button>
                    <Button type="submit" loading={importFetching}>
                      Fetch
                    </Button>
                  </Flex>
                </Flex>
              </Flex>
            </form>
          </>
        )}

        {step === "import-preview" && (
          <>
            <Dialog.Title>Confirm Import</Dialog.Title>
            <form onSubmit={onImportConfirm}>
              <Flex direction="column" gap="3">
                <Card variant="surface">
                  <Flex gap="3" align="center">
                    {/* Not clickable, unlike the work import's preview: the
                        Collection document is deliberately never sent to the
                        browser, so there is nothing here to open in a viewer. */}
                    <span className="import-preview-thumbnail import-preview-thumbnail--static">
                      {importPreview?.thumbnailUrl ? (
                        <img
                          src={importPreview.thumbnailUrl}
                          alt=""
                          onError={(event) => {
                            event.currentTarget.style.display = "none";
                          }}
                        />
                      ) : (
                        <Text size="1" color="gray">Preview</Text>
                      )}
                    </span>
                    <Flex direction="column" gap="1" style={{flex: 1, minWidth: 0}}>
                      <Text weight="medium">{importPreview?.label || "(untitled)"}</Text>
                      {/* The count is shown rather than capped: a few thousand
                          works is a long run, not an error, and the curator is
                          the one who gets to decide that. */}
                      <Text size="2" color="gray">
                        {importPreview?.itemCount ?? 0} work{importPreview?.itemCount === 1 ? "" : "s"}
                        {importPreview?.skippedCollections
                          ? ` · ${importPreview.skippedCollections} sub-collection${
                              importPreview.skippedCollections === 1 ? "" : "s"
                            } skipped`
                          : ""}
                      </Text>
                      <Text size="1" color="gray" style={{wordBreak: "break-all"}}>
                        {importPreview?.sourceUrl}
                      </Text>
                    </Flex>
                  </Flex>
                </Card>

                <NameAndIdFields
                  form={importForm}
                  onChange={onImportFormChange}
                  disabled={importConfirming}
                  namePlaceholder="e.g. Environmental Impact Statements"
                  idPlaceholder="e.g. environmental-impact-statements"
                />

                <Box>
                  <Text as="p" size="1" color="gray">
                    Audio and video canvases are skipped — only images are imported for now.
                    Works fill in as they are copied; you can leave this page.
                  </Text>
                </Box>

                {importError && (
                  <Callout.Root color="red" size="1">
                    <Callout.Text>{importError}</Callout.Text>
                  </Callout.Root>
                )}
                <Flex justify="between" gap="3" mt="2">
                  <Button type="button" variant="ghost" onClick={onBack} disabled={importConfirming}>
                    ← Back
                  </Button>
                  <Flex gap="3">
                    <Button type="button" variant="soft" color="gray" onClick={onClose} disabled={importConfirming}>
                      Cancel
                    </Button>
                    <Button type="submit" loading={importConfirming}>
                      Import
                    </Button>
                  </Flex>
                </Flex>
              </Flex>
            </form>
          </>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}
