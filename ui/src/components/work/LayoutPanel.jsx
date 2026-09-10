import {Box, Flex, Select, Text} from "@radix-ui/themes";

// The four IIIF layout behaviors. The spec defines these as disjoint — exactly
// one applies — so a single-select is the right control, not a multi-select.
const LAYOUT_BEHAVIORS = [
  {value: "individuals", label: "Individuals — one canvas at a time"},
  {value: "paged", label: "Paged — book-style two-page spreads"},
  {value: "continuous", label: "Continuous — canvases joined end to end"},
  {value: "unordered", label: "Unordered — no inherent sequence"},
];
const BEHAVIOR_UNSET = "__unset__";

export default function LayoutPanel({manifest, onSaveBehavior}) {
  const behavior = Array.isArray(manifest?.behavior) ? manifest.behavior[0] : null;
  return (
    <Flex direction="column" className="metadata-panel metadata-fields">
      <Box>
        <Text as="p" size="2" color="gray" mb="1">Display</Text>
        <Select.Root
          value={behavior || BEHAVIOR_UNSET}
          onValueChange={(value) => onSaveBehavior(value === BEHAVIOR_UNSET ? null : [value])}
        >
          <Select.Trigger placeholder="Not set" size="2" />
          <Select.Content>
            <Select.Item value={BEHAVIOR_UNSET}>Not set</Select.Item>
            {LAYOUT_BEHAVIORS.map((option) => (
              <Select.Item key={option.value} value={option.value}>
                {option.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </Box>
    </Flex>
  );
}
