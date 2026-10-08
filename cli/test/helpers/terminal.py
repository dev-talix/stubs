"""Drive the CLI through a real PTY, keeping synthetic input off its command line."""

import base64
import json
import os
import select
import signal
import subprocess
import sys
import termios
import time

request = json.load(sys.stdin)
master, slave = os.openpty()
before = termios.tcgetattr(slave)
child = subprocess.Popen(request["argv"], stdin=slave, stdout=slave, stderr=slave)
output = bytearray()
sent = False
hidden = False
deadline = time.monotonic() + 10
try:
    while True:
        if time.monotonic() > deadline:
            raise RuntimeError("CLI did not finish its hidden-input flow")
        if select.select([master], [], [], 0.05)[0]:
            output.extend(os.read(master, 65536))
        if not sent and b"Ctrl-C cancels." in output:
            flags = termios.tcgetattr(slave)[3]
            hidden = not (flags & (termios.ECHO | termios.ICANON))
            sent = True
            if request.get("signal"):
                child.send_signal(getattr(signal, request["signal"]))
            else:
                for chunk in request["chunks"]:
                    data = base64.b64decode(chunk)
                    while data:
                        data = data[os.write(master, data):]
                    time.sleep(0.02)
        if child.poll() is not None:
            while select.select([master], [], [], 0)[0]:
                output.extend(os.read(master, 65536))
            break
    after = termios.tcgetattr(slave)
    print(json.dumps({
        "code": child.returncode,
        "output": output.decode("utf-8", errors="replace").replace("\r", ""),
        "hidden": hidden,
        "restored": before == after,
    }))
finally:
    if child.poll() is None:
        child.kill()
    child.wait()
    os.close(master)
    os.close(slave)
