import {useState} from "react";
import {Box, Button, Flex, Text} from "@radix-ui/themes";
import MoveWorkDialog from "./MoveWorkDialog";

// Relationships to other IIIF resources. One collection today; this is where a
// future "see also" style link would live too.
//
// This replaced a 350-line combobox. That control existed to make editing a
// *set* safe — chips, free text, tag delimiters, plain-Enter semantics — and a
// work belongs to exactly one collection now, so none of those problems exist.
// Changing it is a deliberate Move rather than an edit-in-place, because it
// takes the work out of one collection and puts it in another.
export default function LinkingPanel({collection, onMove}) {
  const [moving, setMoving] = useState(false);

  return (
    <Flex direction="column" className="metadata-fields">
      <Box>
        <Text as="p" size="2" color="gray" mb="1">
          Collection
        </Text>
        <Flex align="center" gap="3" className="work-collections">
          <Text size="2" weight="bold">
            {collection?.label || "Not in a collection"}
          </Text>
          <Button type="button" size="1" variant="soft" onClick={() => setMoving(true)}>
            Move…
          </Button>
        </Flex>
      </Box>
      <MoveWorkDialog
        open={moving}
        currentSlug={collection?.slug || null}
        onCancel={() => setMoving(false)}
        onMove={async (label) => {
          await onMove(label);
          setMoving(false);
        }}
      />
    </Flex>
  );
}
