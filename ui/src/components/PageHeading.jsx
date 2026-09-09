import {Flex, Text} from "@radix-ui/themes";

// A section's page heading, styled to match a work's title on its own detail
// page: centred, well above the content, and a size that sits between Radix's
// steps (so it comes from CSS, not a `size` prop).
//
// Text rather than Heading, for the same reason the work title is: Heading
// switches to the display face, and the two headings would stop matching.
//
// `asChild` around a real <h2>, because Text's `as` only accepts
// span/div/p/label — anything else is silently rendered as a <span>, which is
// how the work title ended up not being a heading at all. h2, not h1: the
// "Understory" wordmark in AppShell is the page's h1.
export default function PageHeading({children}) {
  return (
    <Flex direction="column" align="center" pt="8">
      <Text asChild weight="bold">
        <h2 className="page-heading">{children}</h2>
      </Text>
    </Flex>
  );
}
