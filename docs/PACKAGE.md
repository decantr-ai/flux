# Package notes

The public source repository is [decantr-ai/flux](https://github.com/decantr-ai/flux); the product feature is [Flux on Decantr](https://decantr.ai/#flux). Flux 0.1.0 is a local preview. Its npm metadata remains `private: true` to prevent accidental registry publication. No npm-registry release or open-source license has been selected.

`npm run pack:local` builds the frontend, gathers dependency notices, checks the archive inventory and host-specific paths, and writes a tarball and checksum to `dist/`. The package contains the managed CLI, runtime modules, prebuilt interface, fonts, and generic project-local Codex skill. It excludes development tests, pilot state, and the legacy developer CLI.

`scripts/harness/package-install.mjs` qualifies an archive in an isolated synthetic project with a fake Codex executable. It uses `/private/tmp` and is currently scoped to macOS-like environments; it does not establish native Codex dispatch or skill discovery on every platform. The core CLI and package should be qualified separately on other supported systems.
