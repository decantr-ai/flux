# Connect the selected chat

The helper is `<skill-directory>/scripts/flux.mjs`. It carries an installation binding to the selected project and installed package. Always pass the exact chat ID with `--session`.

1. Identify the current chat ID and its exact local transcript path using available client context or tools. Do not discover or ingest unrelated chats. If the path is unavailable, explain what is missing instead of guessing.
2. Run `node <helper> connect --session <id> --transcript <absolute-file> --title <project-title>`. The command checks the transcript identity before enrollment. Existing records are retained; a conflicting binding is rejected.
3. Run `node <helper> open --session <id>`. This starts or reuses the matching local service and opens its URL. Report actual status, including unavailable browser launch or capture.
4. Read the snapshot. Set a source-linked current focus or checkpoint only when justified by the current conversation. A new enrollment has no invented project plan.

Lifecycle commands are `start`, `status`, `open`, `stop` and `disconnect`. Start uses an available loopback port unless `--port` is explicit. A connection is one canonical project directory plus one exact chat. Never reuse another chat's state directory to work around an error.

Use the package's `flux --help` for supported flags. If the helper cannot find its installed runtime, reinstall the project skill from the intended package. Do not silently use the Flux development checkout or modify another project's connection.

Only invoke message delivery when the user has explicitly reviewed and authorized it through the established workflow. Installing, connecting, opening or restarting Flux does not send a message to Codex.
