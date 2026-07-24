import json
import redis
import subprocess
from datetime import datetime

r = redis.Redis(
    host="127.0.0.1",
    port=6379,
    decode_responses=True
)

def cmd(command):
    try:
        return subprocess.check_output(
            command,
            shell=True,
            text=True
        ).strip()
    except Exception as e:
        return str(e)

def publish(event_type, message):

    event = {
        "timestamp": datetime.now().isoformat(),
        "agent": "CommandAgent",
        "type": event_type,
        "message": message,
    }

    r.lpush(
        "openclaw:events",
        json.dumps(event)
    )

    print()
    print(json.dumps(event, indent=2))

def summarize_infrastructure():

    docker_status = cmd(
        "docker ps --format '{{.Names}} - {{.Status}}'"
    )

    memory = cmd(
        "free -h | grep Mem"
    )

    disk = cmd(
        "df -h / | tail -1"
    )

    response = f'''
INFRASTRUCTURE SUMMARY

Docker Containers:
{docker_status}

Memory:
{memory}

Disk:
{disk}
'''

    publish(
        "infrastructure_summary",
        response
    )

def recent_events():

    raw = r.lrange(
        "openclaw:events",
        0,
        10
    )

    output = []

    for item in raw:

        try:
            event = json.loads(item)

            output.append(
                f"[{event['agent']}] {event['type']}\n{event['message']}"
            )

        except:
            pass

    publish(
        "recent_events",
        "\n\n".join(output)
    )

def restart_container(container):

    result = cmd(
        f"docker restart {container}"
    )

    publish(
        "container_restart",
        f"{container}: {result}"
    )

def docker_status():

    result = cmd(
        "docker ps --format '{{.Names}} - {{.Status}}'"
    )

    publish(
        "docker_status",
        result
    )

def search_memory(term):

    result = cmd(
        f"cd /home/gravesab/ai/projects/openclaw/tools/memory_context && "
        f"/home/gravesab/ai/projects/openclaw/tools/memory_context/.venv/bin/python3 memory_context_agent.py << EOF\n{term}\nEOF"
    )

    publish(
        "memory_search",
        result
    )

def handle_command(command):

    command = command.lower().strip()

    if "summarize infrastructure" in command:
        summarize_infrastructure()

    elif command == "events":
        recent_events()

    elif "restart homeassistant" in command:
        restart_container("homeassistant")

    elif "restart scrypted" in command:
        restart_container("scrypted")

    elif "show docker status" in command:
        docker_status()

    elif "search memory for" in command:

        term = command.replace(
            "search memory for",
            ""
        ).strip()

        search_memory(term)

    else:

        publish(
            "unknown_command",
            f"Unknown command: {command}"
        )

if __name__ == "__main__":

    print("=" * 60)
    print("COMMAND AGENT")
    print("=" * 60)

    command = input("Enter command: ")

    handle_command(command)
