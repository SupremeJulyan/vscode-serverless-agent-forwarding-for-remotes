# Performance Notes

- SFTP sessions are pooled by SSH host, so folders using the same host reuse a connection.
- Concurrent requests for a disconnected host share one connection attempt.
- File metadata and directory listings use a configurable short-lived cache.
- Successful writes and directory mutations invalidate affected cache entries immediately.
- Remote change detection uses configurable polling because SFTP has no push notification API.
- File content is not cached, avoiding stale editor reads after external updates.
- Remote search runs on the SSH host instead of downloading the workspace.
