// Loop body using EXTERNAL npm libraries: `ms` (duration parser) + `nanoid` (id gen).
// These are declared in workflow.yaml under this node's `deps`; the controller installs
// them into the working copy so this import resolves in-process AND in an isolated container.
import ms from "ms";
import { nanoid } from "nanoid";
export default function enrichOne(e, ctx) {
  return { id: nanoid(10), name: e.name, ttlMs: ms(e.ttl) };
}
