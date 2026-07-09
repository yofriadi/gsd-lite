# /init — author the project identity doc

`/init` owns **`docs/PROJECT.md`** and nothing else. It writes the project's
identity and mission through the `finalize-init` tool. There is no review loop
and no other doc is touched (the REQUIREMENTS/ROADMAP/STATE ledger is bootstrapped
by `/plan`, and the phase artifacts by `/plan`/`/build`).

## Tools

Active tools during `/init`:

- `read` / `find` / `grep` / `ls` — ground the identity in what the repo already is.
- `ask_user_question` — a short interview, only when the answer changes what PROJECT.md should say.
- `finalize-init` — the sole writer of `docs/PROJECT.md`.

`write`, `bash`, and `subagent` are intentionally absent. Do not attempt to
write `docs/PROJECT.md` with anything other than `finalize-init`.

## No goal provided (scaffold mode)

If no goal text is supplied below, do not interview. Immediately call
`finalize-init` with **no `content`** to scaffold the empty PROJECT.md template:

```text
finalize-init({})
```

`finalize-init` refuses to clobber a `docs/PROJECT.md` that already has real
content. If it reports `would-clobber`, tell the user PROJECT.md already exists
and that they should run `/init "<goal>"` to author an update, then stop.

## Goal provided (author mode)

If a goal is supplied below:

1. Briefly ground the identity: read any existing `docs/PROJECT.md`,
   `docs/REQUIREMENTS.md`, `docs/ROADMAP.md`, `docs/STATE.md`, plus `README`
   and the project's setup/config files, so the mission fits the real project
   rather than a greenfield guess.
2. Run a **short** interview (via `ask_user_question`) only for the few facts
   that change the identity doc and that a sensible default cannot answer —
   mission, scope boundaries, and success criteria. Ask one question at a time.
   Do not turn this into a full planning session; `/plan` does the deep work.
3. Author the PROJECT.md markdown yourself and write it with a single
   `finalize-init` call:

```text
finalize-init({ content: "<full PROJECT.md markdown>" })
```

Keep the doc to the identity sections (Mission / Scope / Success criteria).
Content mode is an intentional update and overwrites an existing PROJECT.md, so
fold in what is already there rather than discarding it.

## Do not

- call `write` directly, or write any doc other than `docs/PROJECT.md`
- scaffold or edit REQUIREMENTS/ROADMAP/STATE (that is `/plan`'s job)
- run a plan-reviewer or any review loop
