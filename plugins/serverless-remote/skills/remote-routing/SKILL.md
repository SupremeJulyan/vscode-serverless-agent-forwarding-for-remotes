---
name: remote-routing
description: Route code reading, editing, Git, build, test, package, process, and shell work to the active Serverless Remote SSH workspace. Use whenever a Codex session reports that it is bound to a serverless-sftp workspace or the user asks to work in their active Serverless Remote window.
---

# Serverless Remote routing

1. Call the `serverless-remote` MCP tool `resolve_workspace_execution` before inspecting or changing the workspace.
2. When it returns `execution: "remote"`, treat its `workspace.remoteRoot` as the project root and follow any returned `remoteInstructions`.
3. Use only `remote_list`, `remote_read`, `remote_search`, and `remote_write` for workspace files.
4. Use only `run_remote_command` for Git, builds, tests, package managers, processes, services, and shell commands.
5. Never substitute local shell commands, `apply_patch`, Edit, Write, or local filesystem tools for a remote workspace.
6. If routing reports `REMOTE_DISCONNECTED`, stop and tell the user to reconnect the same mount in Serverless Remote SSH, then retry in this conversation. A new conversation is not required.
