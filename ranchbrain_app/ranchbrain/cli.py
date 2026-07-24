import sys
import argparse
from pathlib import Path
from .config import RANCHBRAIN_DATA, MODULES_DIR
from .indexer import build_index, load_index, index_status
from .search_engine import search as index_search
from .graph_search import graph_search
from .relationship_suggestions import suggest_relationships
from .doctor import run_doctor
from .profile_manager import PROFILES
from .memory_store import remember as remember_memory, find_memory_by_id, list_memories, memory_stats, link_memories, find_backlinks

MODULES = ["system", "budget", "health", "property", "projects", "homeassistant"]

def status(profile: str = "knowledge"):
    from .indexer import load_index

    print("RanchBrain Status")
    print(f"Data: {RANCHBRAIN_DATA}")
    print(f"Profile: {profile}")

    index = load_index(profile)
    print(f"Indexed records: {len(index)}")
    print()

    for name in ["system", "budget", "health", "property", "projects", "homeassistant"]:
        module_path = MODULES_DIR / name
        count = len([x for x in module_path.rglob("*") if x.is_file()]) if module_path.exists() else 0
        print(f"{name}: {count} files")

def search(query: str, profile: str = "knowledge") -> None:
    hits, total = index_search(query, profile=profile)

    if not hits:
        print("No matches found.")
        return

    for path, line_no, line in hits:
        print(f"{path}:{line_no}: {line}")

    print(f"\nShowing {len(hits)} of {total} indexed line matches for profile: {profile}.")

def print_counter(title: str, data: dict) -> None:
    print(f"\n{title}")
    if not data:
        print("  none")
        return

    for key, value in sorted(data.items(), key=lambda x: (-x[1], x[0])):
        print(f"  {key}: {value}")

def profiles_cmd() -> None:
    print("RanchBrain Index Profiles")
    print("=========================")

    for name, profile in PROFILES.items():
        print(f"\n{name}")
        print("Roots:")
        for root in profile.roots:
            print(f"  - {root}")
        print(f"Include top: {sorted(profile.include_top) if profile.include_top else 'all'}")
        print(f"Exclude top: {sorted(profile.exclude_top) if profile.exclude_top else 'none'}")
        print(f"Exclude any: {sorted(profile.exclude_any) if profile.exclude_any else 'none'}")

def memory_cmd(argv: list[str]) -> None:
    if len(argv) >= 1 and argv[0] == "suggest":
        parser = argparse.ArgumentParser(
            prog="ranchbrain memory suggest"
        )
        parser.add_argument("memory_id")
        parser.add_argument("--limit", type=int, default=10)
        parser.add_argument("--min-score", type=int, default=20)
        parser.add_argument(
            "--include-tests",
            action="store_true",
            help="Include memories whose category is test.",
        )
        args = parser.parse_args(argv[1:])

        if args.limit < 1:
            print("❌ --limit must be at least 1")
            raise SystemExit(2)

        if args.min_score < 0:
            print("❌ --min-score must be zero or greater")
            raise SystemExit(2)

        try:
            suggestions = suggest_relationships(
                args.memory_id,
                limit=args.limit,
                min_score=args.min_score,
                include_tests=args.include_tests,
            )
        except ValueError as exc:
            print(f"❌ {exc}")
            raise SystemExit(1)

        print(f"Relationship suggestions for {args.memory_id}")
        print("=" * 60)

        if not suggestions:
            print("No suggestions found.")
            return

        for item in suggestions:
            memory = item.memory
            print(
                f"{item.score:3} | {memory.id} | "
                f"{memory.module} | {memory.title}"
            )
            for reason in item.reasons:
                print(f"      - {reason}")

        print()
        print("Suggestions only; no relationships were created.")
        return

    if len(argv) >= 1 and argv[0] == "backlinks":
        if len(argv) < 2:
            print("Usage: ranchbrain memory backlinks <memory_id>")
            raise SystemExit(1)

        try:
            backlinks = find_backlinks(argv[1])
        except ValueError as e:
            print(f"❌ {e}")
            raise SystemExit(1)

        print(f"Backlinks to {argv[1]}")
        print("=" * 60)

        if not backlinks:
            print("No backlinks.")
            return

        for _, memory, rel in backlinks:
            print(f"{rel.relationship_type:15} {memory.id} | {memory.title}")
            if rel.note:
                print(f"    Note: {rel.note}")

        return

    if len(argv) >= 1 and argv[0] == "relationships":
        if len(argv) < 2:
            print("Usage: ranchbrain memory relationships <memory_id>")
            raise SystemExit(1)

        result = find_memory_by_id(argv[1])
        if result is None:
            print(f"Memory not found: {argv[1]}")
            raise SystemExit(1)

        _, memory = result

        print(f"Relationships for {memory.id}")
        print("=" * 60)

        if not memory.relationships:
            print("No relationships.")
            return

        for rel in memory.relationships:
            print(f"{rel.relationship_type:15} {rel.target_id}")
            if rel.note:
                print(f"    Note: {rel.note}")
        return

    if len(argv) >= 2 and argv[0] == "show":
        result = find_memory_by_id(argv[1])
        if not result:
            print(f"Memory not found: {argv[1]}")
            raise SystemExit(1)

        path, memory = result
        print(memory.to_json())
        print(f"\nPath: {path}")
        return

    if len(argv) >= 1 and argv[0] == "list":
        parser = argparse.ArgumentParser(prog="ranchbrain memory list")
        parser.add_argument("--module", default="")
        parser.add_argument("--type", default="", dest="memory_type")
        parser.add_argument("--category", default="")
        parser.add_argument("--tag", default="")
        parser.add_argument("--limit", type=int, default=25)
        args = parser.parse_args(argv[1:])

        items = list_memories(
            module=args.module or None,
            limit=args.limit,
            memory_type=args.memory_type or None,
            category=args.category or None,
            tag=args.tag or None,
        )

        if not items:
            print("No memories found.")
            return

        for _, memory in items:
            print(
                f"{memory.created_at[:10]} | {memory.module} | "
                f"{memory.memory_type} | {memory.id} | {memory.title}"
            )

        print(f"\nShowing {len(items)} memories.")
        return

    if len(argv) >= 1 and argv[0] == "link":
        parser = argparse.ArgumentParser(prog="ranchbrain memory link")
        parser.add_argument("source_id")
        parser.add_argument("target_id")
        parser.add_argument("--type", default="related", dest="relationship_type")
        parser.add_argument("--note", default="")
        args = parser.parse_args(argv[1:])

        try:
            created = link_memories(
                args.source_id,
                args.target_id,
                relationship_type=args.relationship_type,
                note=args.note,
            )
        except ValueError as e:
            print(f"❌ {e}")
            raise SystemExit(1)

        if created:
            print("✅ Memory relationship created")
        else:
            print("ℹ️ Memory relationship already exists")
        return

    if len(argv) >= 1 and argv[0] == "stats":
        stats = memory_stats()
        print("RanchBrain Memory Stats")
        print("=======================")
        print(f"Total memories: {stats['total']}")
        print_counter("By Module", stats["modules"])
        print_counter("By Type", stats["types"])
        print_counter("By Category", stats["categories"])
        print_counter("By Tag", stats["tags"])
        return

    print("Usage:")
    print("  ranchbrain memory show <id>")
    print("  ranchbrain memory relationships <id>")
    print("  ranchbrain memory backlinks <id>")
    print("  ranchbrain memory suggest <id> [--limit 10] [--min-score 20]")
    print("  ranchbrain memory link <source_id> <target_id> [--type related] [--note text]")
    print("  ranchbrain memory list [--module property] [--type event] [--category maintenance] [--tag pool] [--limit 25]")
    print("  ranchbrain memory stats")
    raise SystemExit(1)

def remember_cmd(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(prog="ranchbrain remember")
    parser.add_argument("--module", required=True)
    parser.add_argument("--category", default="general")
    parser.add_argument("--type", default="event", dest="memory_type")
    parser.add_argument("--title", required=True)
    parser.add_argument("--body", required=True)
    parser.add_argument("--tags", default="")
    parser.add_argument("--url", default="")

    args = parser.parse_args(argv)

    tags = [x.strip() for x in args.tags.split(",") if x.strip()]

    result = remember_memory(
        module=args.module,
        category=args.category,
        title=args.title,
        body=args.body,
        memory_type=args.memory_type,
        tags=tags,
        url=args.url or None,
    )

    if result.status == "created":
        print("✅ Memory created")
    elif result.status == "duplicate":
        print("ℹ️ Memory already exists")
    else:
        print(f"Status: {result.status}")

    print(f"ID: {result.memory_id}")
    print(f"Path: {result.path}")

def version() -> None:
    print("RanchBrain")
    print("Version: 1.0.0-alpha")
    print("Codename: Foundation")
    print("Sprint: 001")
    print("Status: Alpha development")

def main() -> None:
    if len(sys.argv) < 2:
        status()
        return

    cmd = sys.argv[1]

    if cmd == "status":
        parser = argparse.ArgumentParser(prog="ranchbrain status")
        parser.add_argument("--profile", default="knowledge")
        args = parser.parse_args(sys.argv[2:])
        status(args.profile)
    elif cmd in ("version", "--version", "-v"):
        version()
    elif cmd == "doctor":
        raise SystemExit(run_doctor())
    elif cmd == "profiles":
        profiles_cmd()
    elif cmd == "remember":
        remember_cmd(sys.argv[2:])
    elif cmd == "memory":
        memory_cmd(sys.argv[2:])
    elif cmd == "search" and len(sys.argv) >= 3:
        parser = argparse.ArgumentParser(prog="ranchbrain search")
        parser.add_argument("query", nargs="+")
        parser.add_argument("--profile", default="knowledge")
        parser.add_argument(
            "--related",
            action="store_true",
            help="Include memories connected by relationships or backlinks.",
        )
        parser.add_argument(
            "--depth",
            type=int,
            default=1,
            help="Relationship traversal depth from 0 to 5. Default: 1.",
        )
        args = parser.parse_args(sys.argv[2:])
        query = " ".join(args.query)

        search(query, profile=args.profile)

        if args.related:
            try:
                nodes = graph_search(query, max_depth=args.depth)
            except ValueError as exc:
                print(f"❌ {exc}")
                raise SystemExit(2)

            print()
            print("Graph Context")
            print("=============")

            direct = [node for node in nodes if node.depth == 0]

            if not direct:
                print("No structured memory matched the query.")
                return

            print("Direct memory matches")
            print("---------------------")
            for node in direct:
                memory = node.memory
                print(
                    f"0  {memory.id} | {memory.module} | "
                    f"{memory.memory_type} | {memory.title}"
                )

            for depth in range(1, args.depth + 1):
                level = [node for node in nodes if node.depth == depth]

                if not level:
                    continue

                print()
                print(f"Depth {depth}")
                print("-" * (6 + len(str(depth))))

                for node in level:
                    memory = node.memory
                    arrow = "→" if node.direction == "outgoing" else "←"
                    wording = (
                        "linked from"
                        if node.direction == "outgoing"
                        else "linked to by"
                    )

                    print(
                        f"{arrow} {node.relationship_type}\n"
                        f"   {memory.id} | {memory.title}\n"
                        f"   {wording} {node.parent_id}"
                    )

                    if node.note:
                        print(f"   Note: {node.note}")

            if len(nodes) == len(direct):
                print()
                print("No connected memories found.")
    elif cmd == "index":
        if len(sys.argv) >= 3 and sys.argv[2] == "status":
            print("RanchBrain Index Status")
            print("=======================")

            for item in index_status():
                state = "OK" if item["exists"] else "MISSING"
                print(
                    f'{item["profile"]:10} '
                    f'{state:8} '
                    f'{item["records"]:5} records   '
                    f'{item["size"]:8} bytes'
                )
                print(f'   Last indexed: {item.get("indexed_at","unknown")}')
                print(f'   {item["path"]}')

            raise SystemExit(0)

        parser = argparse.ArgumentParser(prog="ranchbrain index")
        parser.add_argument("--profile", default="knowledge")
        parser.add_argument(
            "--full",
            action="store_true",
            help="Force a complete rebuild."
        )
        parser.add_argument(
            "--incremental",
            action="store_true",
            help="Force incremental indexing."
        )

        args = parser.parse_args(sys.argv[2:])

        incremental = True
        if args.full:
            incremental = False
        elif args.incremental:
            incremental = True

        records = build_index(
            profile_name=args.profile,
            incremental=incremental,
        )

        mode = "full" if not incremental else "incremental"

        print(
            f"Indexed {len(records)} files for profile: "
            f"{args.profile} ({mode})"
        )
    else:
        print("Usage:")
        print("  ranchbrain status")
        print('  ranchbrain search "query"')
        raise SystemExit(1)
