# Flux product boundaries

Flux maintains local, explicitly scoped project and chat records. Enrollment requires an existing project directory, exact session ID, and a transcript whose session metadata matches. Records and runtime state stay under the project's `.flux` directory. Disconnect stops managed capture and retains the journal; reconnect is explicit.

Captured activity is observational and can be incomplete. Plans, decisions, focus, and explanations are explicit reports, not access to private model reasoning. Flux does not infer authorization from a transcript or silently dispatch messages. Where dispatch is available, a person reviews and initiates it. No native hooks are automatically installed.

The service binds to loopback. Runtime identity and shutdown use private per-instance credentials; an unverified occupied port is not treated as a stopped service. Flux cannot guarantee deletion of previously retained records or independent backups.
