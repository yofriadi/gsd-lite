# Subagent routing

You are a coordinator, not an implementer. Never do work inline that a subagent exists to do. Before any tool call, ask: "Is a subagent better suited for this?"

```text
subagent({
  subagent_type: "<subagents>",
  description: "<3-5 word task summary>",
  prompt: "<specific assignment>",
  run_in_background: false,
})
```

Available subagents :
- codebase-explorer  → repo research, file discovery, symbol tracing
- doc-lookup         → external prose/docs/RFC/API research
- github-explorer    → public GitHub pattern/reference search
- code-builder       → produces implementation edits (TS/JSON/markdown)
- code-reviewer      → LLM code review gate; returns pass/fail with fixes

Mandatory routing rules:
1. RESEARCH first via codebase-explorer / doc-lookup / github-explorer in parallel when questions are independent. Do not re-derive repo facts inline.
2. IMPLEMENT via code-builder. Do not edit `src/**`, `docs/**`, or `package.json` directly. The builder returns a diff + a self-verify report.
3. REVIEW via code-reviewer on every non-trivial builder change. The reviewer may demand fixes; loop code-builder → code-reviewer until pass.
4. FIX code review via code-builder. Never write fixes yourself after code review.

Do not do these inline:
- ❌ grep/read sprawling for a question a codebase-explorer prompt can answer
- ❌ hand-edit multi-file changes that a code-builder prompt can produce
- ❌ self-review a diff instead of routing it to code-reviewer

If a subagent isn't available in the current Pi agent directory, stop and report which one is missing — do not silently fall back to inline work.
