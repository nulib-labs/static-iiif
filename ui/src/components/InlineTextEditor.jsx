import {useEffect, useState} from "react";
import {Flex, IconButton, Text, TextArea, TextField} from "@radix-ui/themes";
import {CheckIcon} from "@radix-ui/react-icons";

// Click the text to edit it in place; Check (or Enter) saves and reverts to plain
// text, Escape cancels. Used for canvas labels and every manifest metadata field.
//   multiline  — a TextArea, where Enter inserts a newline and only Check saves.
//   allowEmpty — permit clearing the value (a description can be removed; a
//                canvas label cannot, so it keeps the default guard).
export default function InlineTextEditor({
  value: savedValue,
  onSave,
  multiline = false,
  allowEmpty = false,
  placeholder = "Not set",
  as = "p",
  textProps = {weight: "bold", size: "2"},
  fieldSize = "1",
  ariaLabel = "Edit value",
  className = "",
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(savedValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!editing) setDraft(savedValue);
  }, [savedValue, editing]);

  const startEditing = () => {
    setError(null);
    setDraft(savedValue);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setDraft(savedValue);
    setError(null);
  };

  const handleSave = async () => {
    const trimmed = draft.trim();
    if ((!trimmed && !allowEmpty) || trimmed === savedValue) {
      cancelEditing();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <Text
        as={as}
        {...textProps}
        color={savedValue ? textProps.color : "gray"}
        role="button"
        tabIndex={0}
        className={`canvas-label-editable ${className}`.trim()}
        onClick={startEditing}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            startEditing();
          }
        }}
      >
        {savedValue || placeholder}
      </Text>
    );
  }

  const onKeyDown = (event) => {
    // In a TextArea Enter has to stay a newline, so Check is the only way to save.
    if (event.key === "Enter" && !multiline) handleSave();
    if (event.key === "Escape") cancelEditing();
  };

  return (
    <Flex direction="column" gap="1">
      <Flex align={multiline ? "end" : "center"} gap="1">
        {multiline ? (
          <TextArea
            size={fieldSize}
            value={draft}
            autoFocus
            disabled={saving}
            rows={3}
            style={{flex: 1}}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
        ) : (
          <TextField.Root
            size={fieldSize}
            value={draft}
            style={{flex: 1}}
            autoFocus
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
        )}
        <IconButton size={fieldSize} variant="soft" onClick={handleSave} loading={saving} aria-label={ariaLabel}>
          <CheckIcon />
        </IconButton>
      </Flex>
      {error && <Text as="p" size="1" color="red">{error}</Text>}
    </Flex>
  );
}
