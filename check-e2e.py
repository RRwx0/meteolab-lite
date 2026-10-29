import json
import time
import urllib.request

BASE = "http://127.0.0.1:8791"


def call(path, method="GET", payload=None):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as response:
        return response.status, response.read()


print("health:", json.loads(call("/api/wts/health")[1]))

status, body = call(
    "/api/wts/jobs",
    "POST",
    {
        "station": "24959",
        "start": "2024-06-01",
        "end": "2024-06-01",
        "hours": ["12"],
        "workers": 1,
        "delay": 0,
    },
)
snapshot = json.loads(body)
job_id = snapshot["id"]
print("job:", job_id, "total", snapshot["counts"]["total"])

deadline = time.time() + 120
final = snapshot
while time.time() < deadline:
    final = json.loads(call("/api/wts/jobs/%s?since=0" % job_id)[1])
    if final["status"] in ("done", "stopped", "error"):
        break
    time.sleep(1)

print("status:", final["status"], final["counts"])
print("log:", [(e["status"], e["message"][:70]) for e in final["log"][-4:]])

files = json.loads(call("/api/wts/jobs/%s/files" % job_id)[1])
print("files:", [f["path"] for f in files["files"]])
if files["files"]:
    status, body = call(files["files"][0]["url"])
    text = body.decode("utf-8")
    print("snd bytes:", len(body))
    print("\n".join(text.splitlines()[:8]))
    print("...")
    print(text.splitlines()[-1])
    status, zip_body = call("/api/wts/jobs/%s/zip" % job_id)
    open("e2e-result.zip", "wb").write(zip_body)
    print("zip bytes:", len(zip_body))
