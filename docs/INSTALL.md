# Install and connect

Flux is currently a local preview. From a source checkout, install Node.js 22 or later and npm, then run `npm ci`, `npm run build`, and `npm run pack:local`. Install the resulting archive locally using your preferred npm prefix, for example `npm install --prefix <directory> <path-to-archive>`. The executable is at `<directory>/node_modules/.bin/flux`.

The local package is tested on macOS. Linux and Windows are not release-qualified. Native skill discovery and real queue delivery from the installed package still need client-specific verification; a successful local connection does not establish those capabilities.

Choose an existing project directory, the exact Codex session ID, and its matching transcript file. Then run:

```sh
flux connect --project <project-directory> --session <session-id> --transcript <transcript-file>
flux install-skill --project <project-directory>
flux open --project <project-directory> --session <session-id>
```

Use `flux status --project <project-directory>` to list that project's connections, and add `--session <session-id>` for one chat. `stop` stops the service; `disconnect` also disables capture while retaining the journal. Reconnect explicitly with the same transcript. `uninstall-skill --project <project-directory>` removes the installed Flux skill when its ownership checks pass.

Flux stores data in `<project>/.flux/chats/` and creates a `.flux/.gitignore` on a new workspace. Existing ignore rules are preserved, so verify your own rules if that file already exists. Keep this local state private. Flux persists its initially selected loopback port so browser-local drafts survive ordinary restarts; explicitly changing ports changes the browser origin and can make those drafts unavailable. If an occupied port cannot be authenticated, Flux refuses to start another instance.

`flux help` lists commands. No hooks or background message dispatch are installed by connecting. Some UI actions explicitly request reviewed dispatch through a local Codex environment; capture and dispatch depend on that environment and are not a record of hidden reasoning.

A lifecycle lock left by a crashed command fails closed. Inspect the affected workspace and confirm that no connect/start/stop command is running before manually removing its `lifecycle.lock` directory. Do not remove locks during normal operation. Stop or disconnect services before uninstalling the package; records remain until you explicitly delete their data directory.
