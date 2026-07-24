# Performance Roadmap

Startup and runtime performance work was implemented in this order:

1. [x] Run dependency checks in parallel and cache their results.
2. [x] Reuse the loaded configuration and remove duplicate mount-status checks.
3. [x] Add phase timing logs to identify the measured bottleneck.
4. [x] Reuse Linux/macOS and WSL bridge SSH connections with OpenSSH
   ControlMaster.
5. [x] Start the SSHFS mount and remote terminal concurrently where failure
   handling and connection-reuse ordering permit.
6. [x] Provide SSHFS cache profiles for freshness/performance trade-offs.

The ordering is intentional: complete and measure each item before starting the
next, so later architectural changes are based on observed timings.

WSL delegates SSH process ownership to the separately installed bridge. The
extension forwards the connection-reuse preference to that bridge and orders
mount before terminal so the terminal can reuse the SSHFS master connection.
