Narrow a hook that runs over the whole project to the files that changed; only when the caller asked for the change

1. Find the hook: `await scripts.run("inventory")` lists `gitHooks` and `claudeHooks` with the
   command and whether it already looks at changed files (`narrowedToChangedFiles`).
2. Read the hook file with `repo.read`. Note the command, the tool and what it accepts for file
   arguments (`cargo fmt -- <files>`, `eslint <files>`, `prettier --check <files>`, `ruff <files>`;
   some tools, such as `cargo clippy`, work on the whole crate and cannot take files).
3. For a tool that takes files, take them from git: staged files for pre-commit
   (`git diff --cached --name-only --diff-filter=ACM`), the files in the push for pre-push
   (`git diff --name-only @{upstream}...HEAD`), filtered by the extensions the tool reads. Quote the
   list, pass it with `--`, and exit 0 when the list is empty.
4. For a tool that cannot take files, narrow by path instead: run it only when a changed file is in
   the folder the tool covers (`git diff --cached --name-only | grep -q '^crates/'`), and skip
   otherwise.
5. If the repository uses lefthook, Husky or pre-commit, use that tool's own changed-files setting
   (`glob:` with `{staged_files}`, lint-staged, the framework's `files:`), not a new script.
6. Edit with `repo.edit`, then show `git diff` for the file. Do not run the hook or the suite. Say in
   the answer what the hook did before, what it does now, and what no longer runs on a change
   outside the narrowed set (CI still runs the whole check, when it does: give the workflow path).
