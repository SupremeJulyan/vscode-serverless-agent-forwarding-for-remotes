#!/usr/bin/env python3
"""Small TCP relay for reaching a VPN-only SSH host from WSL."""

import argparse
import asyncio
import contextlib
import datetime


def log(message: str) -> None:
    timestamp = datetime.datetime.now().isoformat(timespec="seconds")
    try:
        print(f"{timestamp} {message}", flush=True)
    except OSError:
        pass


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        with contextlib.suppress(Exception):
            writer.write_eof()


async def relay(
    client_reader: asyncio.StreamReader,
    client_writer: asyncio.StreamWriter,
    target_host: str,
    target_port: int,
) -> None:
    peer = client_writer.get_extra_info("peername")
    log(f"connection from {peer}")
    try:
        remote_reader, remote_writer = await asyncio.open_connection(
            target_host, target_port
        )
    except Exception as exc:
        log(f"target connection failed for {peer}: {exc}")
        client_writer.close()
        await client_writer.wait_closed()
        return

    tasks = {
        asyncio.create_task(pipe(client_reader, remote_writer)),
        asyncio.create_task(pipe(remote_reader, client_writer)),
    }
    _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    for writer in (client_writer, remote_writer):
        writer.close()
        with contextlib.suppress(Exception):
            await writer.wait_closed()
    log(f"connection closed for {peer}")


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen-host", default="127.0.0.1")
    parser.add_argument("--listen-port", type=int, default=2222)
    parser.add_argument("--target-host", default="10.0.0.10")
    parser.add_argument("--target-port", type=int, default=22)
    parser.add_argument(
        "--idle-exit-seconds",
        type=float,
        default=0,
        help="exit after the last client disconnects and this idle period elapses",
    )
    args = parser.parse_args()

    shutdown_event = asyncio.Event()
    active_connections = 0
    had_connection = False
    idle_task: asyncio.Task[None] | None = None

    async def exit_after_idle() -> None:
        await asyncio.sleep(args.idle_exit_seconds)
        shutdown_event.set()

    async def tracked_relay(
        client_reader: asyncio.StreamReader,
        client_writer: asyncio.StreamWriter,
    ) -> None:
        nonlocal active_connections, had_connection, idle_task
        if idle_task is not None:
            idle_task.cancel()
            idle_task = None
        active_connections += 1
        had_connection = True
        try:
            await relay(
                client_reader,
                client_writer,
                args.target_host,
                args.target_port,
            )
        finally:
            active_connections -= 1
            if (
                had_connection
                and active_connections == 0
                and args.idle_exit_seconds > 0
            ):
                idle_task = asyncio.create_task(exit_after_idle())

    server = await asyncio.start_server(
        tracked_relay,
        args.listen_host,
        args.listen_port,
    )
    addresses = ", ".join(str(sock.getsockname()) for sock in server.sockets or [])
    log(f"listening on {addresses} -> {args.target_host}:{args.target_port}")
    async with server:
        if args.idle_exit_seconds <= 0:
            await server.serve_forever()
        else:
            serve_task = asyncio.create_task(server.serve_forever())
            await shutdown_event.wait()
            serve_task.cancel()
            await asyncio.gather(serve_task, return_exceptions=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
