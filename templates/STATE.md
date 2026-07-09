# State

<!-- Per-plan status ledger + current pointer. The json block below is the
     sole source of truth; this prose is freeform. Written by /plan and
     finalize-build. `pointer` is the plan `/build` resolves by default (or
     null when nothing is pending); `next` is a rendered next action pointer;
     each plan is pending -> planned -> built. -->

```json
{
  "pointer": null,
  "next": null,
  "plans": []
}
```
