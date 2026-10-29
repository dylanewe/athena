# Eligible source browsing (#4)

Open **Sources** after designating a folder in **Repositories**. List files recursively, search literal text (case-insensitive), or read a line range. No repository prompt, model request, paid work, Git command, branch switch, history read, generator, shell, or investigated-folder write occurs. Files reflect the current checkout, including eligible untracked and modified files. Non-Git documents need no manifest.

## Access contract

`src/main/sources.ts` is the shared access boundary for renderer requests and the three future Pi tools in `source-tools.ts`: `sources_list`, `sources_search`, and `sources_read`. The tools cannot change policy. UI requests additionally require the owning Electron window, main frame, exact packaged document URL, and validated operation/payload. Agent tooling is supplied as an adapter, **not attached to the demonstration or the connection test**.

Every operation revalidates the saved canonical folder, relative path, and all path components. Absolute paths, traversal, symlinks (including in-root links), non-regular files, and escape from approved folders are denied. Git internals and common environment/credential-bearing filenames are protected before content opens, including `.env` variants, `.envrc`, registry/credential dotfiles, SSH/cloud directories, private key formats, credential/secret files, and Terraform secret/state files. Recognizable `.env.example`, `.env.local.template`, and similar example names are eligible, but their contents receive the same secret checks as all other text. This is conservative filename filtering plus heuristic content detection, not proof of safety.

Hidden, vendor/dependency, build, generated/minified/lock files, and locally ignored files are excluded by default. `.gitignore` rules apply hierarchically, including negation and nested files; local `.git/info/exclude` is honored. A new Git boundary resets inherited ignore rules. Ignored ancestor directories are not descended by default. External Git configuration, global ignore files, Git hooks, attributes/filters, external worktree metadata, and external symlink targets are **never read**. Unavailable, symlinked, or oversized safety metadata fails closed rather than treating its contents as absent.

Results expose exclusion reasons. **Include this exclusion** or **Exclusions and saved exceptions** can persist a file/subtree exception in `sources.sqlite`; remove it to restore defaults. An exact file exception permits traversal of excluded ancestors, not access to its siblings. Exceptions override only default hidden/vendor/generated/ignore exclusions. They cannot override consent, confinement, Git/credential protections, symlinks, binary/encoding/size limits, or secret checks. Source exceptions are separate from repository-discovery includes and do not register repositories.

## Evidence and limits

Eligible input is UTF-8 code or text, including Markdown, plain text, JSON, YAML, TOML, XML, and extensionless text. Known media/archive/binary formats, binary control bytes, invalid UTF-8, and files over 256 KiB are withheld. No PDF/image interpretation is provided. Entire bounded files are secret-checked **before** extracting a range or search match, so a benign first line cannot preview a secret elsewhere in that file.

Each operation is capped at 5 seconds, 2,000 visited entries, 200 result entries, 40 directory levels, 2 MiB input (including safety/revision metadata), and 64 KiB serialized output. Ranges contain at most 200 lines; individual excerpts are limited to 16 KiB. Excluded/unsupported paths carry reasons; global time/entry/byte/result/depth limits return explicit `truncated` status. Cancellation returns partial `cancelled` results and prevents further content reads, including when a pending OS open completes late. A pending native filesystem call cannot itself be interrupted, but no late result is exposed.

Excerpts carry designated-folder identity, folder-relative path, nearest live repository path/name (including newly created nested repositories), line range, current checkout revision when available, and SHA-256 content identity. Repository names use saved aliases when available; the path disambiguates unresolved collisions. Non-Git sources have a null repository/revision. Unborn repositories and worktrees/submodules whose metadata is external or represented by gitfiles report unavailable revision rather than following gitdir pointers outside consent. Ordinary loose and packed refs are supported. Citations describe observed content, not an atomic checkout snapshot; content identity distinguishes uncommitted changes from the cited revision. Re-read evidence if files change during an investigation. Concurrent changes during a file read are rejected.

## Secrets and future investigators

Suspected secrets cause the entire file's content to be withheld; matches/values are not included in errors, ordinary logs, or SQLite. Browsed content is held only in memory, not cached or persisted. Secret detection **is not a guarantee**; the UI warns users to review excerpts. Examples/templates have no content-level exemption.

`checkBeforeModelSend` checks composed material; the Pi tool adapter checks its entire outgoing result (including paths/citations), and the existing fixed connection transport checks its final wire body before fetch. Future investigation transports must use this guard at the final request boundary as well as independently enforce provider approval, environment/secret permissions, and paid-work consent. This slice neither sends browsed material nor expands those permissions.

Repository instructions, comments, and documents are untrusted evidence rendered as plain text, not executable instructions. None of these tools provides shell, execution, write, or network capabilities. A working directory is not an access boundary. This is trusted application code with component checks, `O_NOFOLLOW`, descriptor identity checks, and revalidation; it is **not an OS filesystem sandbox or an atomic capability against a hostile process continuously mutating ancestor directories**. Investigated repositories remain read-only.

## Validation

- `tests/unit/sources.test.ts`: real controlled Git/filesystem/SQLite fixtures, consent denial before opens, environment examples versus actual credentials, full-file secret checks, traversal/symlink/replaced-parent cases, non-Git citations, current checkout and nested ownership, packed refs, external gitfiles, ignore rules, persisted narrow exceptions, unsupported/bounded inputs, time/entry/depth/byte/result limits, and cancellation (including a delayed OS open).
- `tests/unit/source-bridge.test.ts`: caller and payload validation, capability rejection, cancellation, and concurrency.
- `tests/desktop/sources.spec.ts`: actual Electron preload/IPC, browsing/search/range UI, plain-text rendering, secret/environment denial, exclusions and persisted exceptions across restart, and no model processes. Only the native folder picker is replaced.

Run `npm test`; no live model calls or credentials are required.
