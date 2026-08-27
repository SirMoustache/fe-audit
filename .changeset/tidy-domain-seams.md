---
'fe-audit': patch
---

Internal restructuring, no behavioural change.

The advisory shape is now owned by the domain rather than defined twice, once
there and once in the client that fetches it. `readDeclarations` moved from
`verification` to `override-set`, beside the code that writes the grammar it
parses. Project loading is shared by every command instead of being repeated
five times, which had begun to let the parts drift. `UsageReport` no longer
carries a `sourceFileCount` the domain cannot know.
