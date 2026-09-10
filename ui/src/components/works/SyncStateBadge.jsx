import {Badge, Text} from "@radix-ui/themes";

// How this work compares to what is published. The backend supplies it once the
// collection-scoped works route exists; until then every row reports nothing and
// renders a dash, so the column is in place without pretending to know.
const STATES = {
  new: {label: "Not published", color: "orange"},
  changed: {label: "Changed", color: "orange"},
  published: {label: "Published", color: "green"},
};

export default function SyncStateBadge({state}) {
  const known = STATES[state];
  if (!known) {
    return (
      <Text size="2" color="gray">
        —
      </Text>
    );
  }
  return (
    <Badge size="1" variant="soft" radius="full" color={known.color}>
      {known.label}
    </Badge>
  );
}
