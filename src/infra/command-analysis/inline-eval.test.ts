// Covers interpreter inline-eval flag detection, positional program forms, and
// allowlist pattern matching for approval policy.
import { describe, expect, it } from "vitest";
import type { InterpreterInlineEvalHit } from "./inline-eval.js";
import {
  describeInterpreterInlineEval,
  detectInterpreterInlineEvalArgv,
  isInterpreterLikeAllowlistPattern,
} from "./inline-eval.js";

function expectInlineEvalDescription(hit: InterpreterInlineEvalHit | null, expected: string) {
  if (hit === null) {
    throw new Error(`Expected inline eval hit for ${expected}`);
  }
  expect(describeInterpreterInlineEval(hit)).toBe(expected);
}

describe("exec inline eval detection", () => {
  it.each([
    { argv: ["python3", "-c", "print('hi')"], expected: "python3 -c" },
    { argv: ["python3", "-cprint('hi')"], expected: "python3 -c" },
    { argv: ["python3", "-bc", "print('hi')"], expected: "python3 -c" },
    { argv: ["python3", "-Sc", "print('hi')"], expected: "python3 -c" },
    { argv: ["python3", "-xc", "print('hi')"], expected: "python3 -c" },
    { argv: ["python3.13", "-c", "print('hi')"], expected: "python3.13 -c" },
    { argv: ["/usr/bin/pypy3.10", "-c", "print('hi')"], expected: "pypy3.10 -c" },
    { argv: ["/usr/bin/node", "--eval", "console.log('hi')"], expected: "node --eval" },
    { argv: ["/usr/bin/node", "--eval=console.log('hi')"], expected: "node --eval" },
    { argv: ["bun", "-pconsole.log('hi')"], expected: "bun -p" },
    { argv: ["deno", "--print=1 + 1"], expected: "deno --print" },
    { argv: ["ruby", "-eputs 1"], expected: "ruby -e" },
    { argv: ["ruby", "-ane", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-ce", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-ne", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-00pe", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-p00e", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-pe", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-Se", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-We", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-W2e", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-ve", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-we", "puts 1"], expected: "ruby -e" },
    { argv: ["perl", "-E", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-Esay 1"], expected: "perl -e" },
    { argv: ["perl", "-ce", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-de", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-fe", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-l0e", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-ne", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-0777pe", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-p0777e", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-Se", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-Te", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-UE", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-Ve", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-We", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-we", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-Xe", "say 1"], expected: "perl -e" },
    { argv: ["php", "-B", "system('id');"], expected: "php -B" },
    { argv: ["php", "-rsystem('id');"], expected: "php -r" },
    { argv: ["php", "-E", "system('id');"], expected: "php -E" },
    { argv: ["php", "-R", "system('id');"], expected: "php -R" },
    { argv: ["Rscript", "-e", "system('id')"], expected: "rscript -e" },
    { argv: ["julia", "-e", "run(`id`)"], expected: "julia -e" },
    { argv: ["julia", "-erun(`id`)"], expected: "julia -e" },
    { argv: ["julia", "--eval=run(`id`)"], expected: "julia --eval" },
    { argv: ["julia", "-E", "VERSION"], expected: "julia -E" },
    { argv: ["julia", "-EVERSION"], expected: "julia -E" },
    { argv: ["elixir", "-e", 'System.cmd("id", [])'], expected: "elixir -e" },
    { argv: ["elixir", '--eval=System.cmd("id", [])'], expected: "elixir --eval" },
    {
      argv: ["elixir", "--rpc-eval", "worker@127.0.0.1", 'System.cmd("id", [])'],
      expected: "elixir --rpc-eval",
    },
    { argv: ["iex", "-e", 'System.cmd("id", [])'], expected: "iex -e" },
    {
      argv: ["iex", "--rpc-eval", "worker@127.0.0.1", 'System.cmd("id", [])'],
      expected: "iex --rpc-eval",
    },
    { argv: ["guile", "-c", '(system "id")'], expected: "guile -c" },
    { argv: ["guile", "-e", '(lambda args (system "id"))', "/dev/null"], expected: "guile -e" },
    { argv: ["groovy", "-e", '"id".execute()'], expected: "groovy -e" },
    { argv: ["groovy", '-e"id".execute()'], expected: "groovy -e" },
    { argv: ["groovy", "-ne", '["id"].execute()'], expected: "groovy -e" },
    { argv: ["groovy", "-pe", '["id"].execute()'], expected: "groovy -e" },
    { argv: ["groovy", '-encoding:["id"].execute()'], expected: "groovy -e" },
    { argv: ["scala", "-e", 'sys.process.Process("id").!'], expected: "scala -e" },
    {
      argv: ["scala", "--script-snippet", 'sys.process.Process("id").!'],
      expected: "scala --script-snippet",
    },
    {
      argv: ["scala-cli", "--script-snippet", 'sys.process.Process("id").!'],
      expected: "scala-cli --script-snippet",
    },
    {
      argv: ["scala", "--execute-script", 'sys.process.Process("id").!'],
      expected: "scala --execute-script",
    },
    {
      argv: ["scala", "--execute-sc=println(1)"],
      expected: "scala --execute-sc",
    },
    {
      argv: ["scala", "--execute-scala-script=println(1)"],
      expected: "scala --execute-scala-script",
    },
    {
      argv: ["scala", "--scala-snippet=println(1)"],
      expected: "scala --scala-snippet",
    },
    {
      argv: ["scala", "--execute-scala=println(1)"],
      expected: "scala --execute-scala",
    },
    {
      argv: ["scala", "--java-snippet", "class Main {}"],
      expected: "scala --java-snippet",
    },
    {
      argv: ["scala", "--execute-java=class Main {}"],
      expected: "scala --execute-java",
    },
    {
      argv: ["scala", "--markdown-snippet", "```scala\nprintln(1)\n```"],
      expected: "scala --markdown-snippet",
    },
    {
      argv: ["scala", "--md-snippet=```scala\nprintln(1)\n```"],
      expected: "scala --md-snippet",
    },
    {
      argv: ["scala", "--execute-markdown", "```scala\nprintln(1)\n```"],
      expected: "scala --execute-markdown",
    },
    {
      argv: ["scala", "--execute-md=```scala\nprintln(1)\n```"],
      expected: "scala --execute-md",
    },
    { argv: ["clojure", "-e", '(clojure.java.shell/sh "id")'], expected: "clojure -e" },
    { argv: ["clj", "--eval", "(println 1)"], expected: "clj --eval" },
    { argv: ["raku", "-e", "run 'id'"], expected: "raku -e" },
    { argv: ["raku", "-e say 1"], expected: "raku -e" },
    { argv: ["raku", "-ne", "run 'id'"], expected: "raku -e" },
    { argv: ["perl6", "-e", "run 'id'"], expected: "perl6 -e" },
    { argv: ["perl6", "-pe", "run 'id'"], expected: "perl6 -e" },
    { argv: ["ghc", "-e", 'System.Process.system "id"'], expected: "ghc -e" },
    { argv: ["ghci", "-e", 'System.Process.system "id"'], expected: "ghci -e" },
    { argv: ["erl", "-eval", 'os:cmd("id").'], expected: "erl -eval" },
    { argv: ["erl", "-run", "os", "cmd", "id"], expected: "erl -run" },
    { argv: ["erl", "-s", "os", "cmd", "id"], expected: "erl -s" },
    { argv: ["erl", "-noshell", "-s", "init", "stop"], expected: "erl -s" },
    { argv: ["werl", "-eval", 'os:cmd("id").'], expected: "werl -eval" },
    { argv: ["werl", "-run", "os", "cmd", "id"], expected: "werl -run" },
    { argv: ["gdb", "-ex", "shell id", "-ex", "quit"], expected: "gdb -ex" },
    { argv: ["gdb", "-ex=shell id", "-ex", "quit"], expected: "gdb -ex" },
    { argv: ["gdb", "-iex", "shell id"], expected: "gdb -iex" },
    { argv: ["gdb", "-iex=shell id"], expected: "gdb -iex" },
    { argv: ["gdb", "-ev", "shell id"], expected: "gdb -eval-command" },
    { argv: ["gdb", "-eval", "shell id"], expected: "gdb -eval-command" },
    { argv: ["gdb", "-eval-c", "shell id"], expected: "gdb -eval-command" },
    { argv: ["gdb", "-eval-c=shell id"], expected: "gdb -eval-command" },
    { argv: ["gdb", "-eval-command", "shell id"], expected: "gdb -eval-command" },
    { argv: ["gdb", "-eval-command=shell id"], expected: "gdb -eval-command" },
    { argv: ["gdb", "--ev", "shell id"], expected: "gdb --eval-command" },
    { argv: ["gdb", "--eval", "shell id"], expected: "gdb --eval-command" },
    { argv: ["gdb", "--eval-c=shell id"], expected: "gdb --eval-command" },
    { argv: ["gdb", "--eval-command=shell id"], expected: "gdb --eval-command" },
    { argv: ["gdb", "-init-e", "shell id"], expected: "gdb -init-eval-command" },
    { argv: ["gdb", "-init-eval", "shell id"], expected: "gdb -init-eval-command" },
    { argv: ["gdb", "-init-eval-c=shell id"], expected: "gdb -init-eval-command" },
    { argv: ["gdb", "--init-e", "shell id"], expected: "gdb --init-eval-command" },
    { argv: ["gdb", "--init-eval-command=shell id"], expected: "gdb --init-eval-command" },
    { argv: ["gdb", "--init-eval=shell id"], expected: "gdb --init-eval-command" },
    { argv: ["gdb", "-init-eval-command=shell id"], expected: "gdb -init-eval-command" },
    { argv: ["gdb", "-eiex", "shell id"], expected: "gdb -eiex" },
    { argv: ["gdb", "-eiex=shell id"], expected: "gdb -eiex" },
    {
      argv: ["gdb", "-early-init-e", "shell id"],
      expected: "gdb -early-init-eval-command",
    },
    {
      argv: ["gdb", "-early-init-eval", "shell id"],
      expected: "gdb -early-init-eval-command",
    },
    {
      argv: ["gdb", "--early-init-e=shell id"],
      expected: "gdb --early-init-eval-command",
    },
    {
      argv: ["gdb", "--early-init-eval=shell id"],
      expected: "gdb --early-init-eval-command",
    },
    {
      argv: ["gdb", "-early-init-eval-command=shell id"],
      expected: "gdb -early-init-eval-command",
    },
    { argv: ["expect", "-c", "spawn id"], expected: "expect -c" },
    { argv: ["expect", "-cspawn id"], expected: "expect -c" },
    { argv: ["lua", "-eprint(1)"], expected: "lua -e" },
    { argv: ["osascript", "-e", "beep"], expected: "osascript -e" },
    { argv: ["osascript", '-edisplay alert "hi"'], expected: "osascript -e" },
    { argv: ["awk", "BEGIN { print 1 }"], expected: "awk inline program" },
    { argv: ["gawk", "-F", ",", "{print $1}", "data.csv"], expected: "gawk inline program" },
  ] as const)("detects interpreter eval flags for %j", ({ argv, expected }) => {
    const hit = detectInterpreterInlineEvalArgv([...argv]);
    expectInlineEvalDescription(hit, expected);
  });

  it.each([
    { argv: ["awk", 'BEGIN{system("id")}', "/dev/null"], expected: "awk inline program" },
    {
      argv: ["awk", "-F", ",", 'BEGIN{system("id")}', "/dev/null"],
      expected: "awk inline program",
    },
    { argv: ["gawk", "-e", 'BEGIN{system("id")}', "/dev/null"], expected: "gawk -e" },
    {
      argv: ["gawk", "-f", "library.awk", '--source=BEGIN{system("id")}', "/dev/null"],
      expected: "gawk --source",
    },
    { argv: ["find", ".", "-exec", "id", "{}", ";"], expected: "find -exec" },
    { argv: ["find", "--", ".", "-exec", "id", "{}", ";"], expected: "find -exec" },
    { argv: ["find", ".", "-ok", "id", "{}", ";"], expected: "find -ok" },
    { argv: ["find", ".", "-okdir", "id", "{}", ";"], expected: "find -okdir" },
    { argv: ["xargs", "id"], expected: "xargs inline command" },
    { argv: ["xargs", "-I", "{}", "sh", "-c", "id"], expected: "xargs inline command" },
    { argv: ["xargs", "--replace", "id"], expected: "xargs inline command" },
    { argv: ["make", "-f", "evil.mk"], expected: "make -f" },
    { argv: ["make", "-E", "$(shell id)"], expected: "make -E" },
    { argv: ["make", "-E$(shell id)"], expected: "make -E" },
    { argv: ["make", "--eval=$(shell id)"], expected: "make --eval" },
    { argv: ["sed", "s/.*/id/e", "/dev/null"], expected: "sed inline program" },
    { argv: ["gsed", "-e", "s/.*/id/e", "/dev/null"], expected: "gsed -e" },
    { argv: ["sed", "-es/.*/id/e", "/dev/null"], expected: "sed -e" },
  ] as const)("detects command carriers for %j", ({ argv, expected }) => {
    const hit = detectInterpreterInlineEvalArgv([...argv]);
    expectInlineEvalDescription(hit, expected);
  });

  it("ignores normal script execution", () => {
    expect(detectInterpreterInlineEvalArgv(["python3", "script.py"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["python3.13", "script.py"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["node", "script.js"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["node", "--evalish=console.log(1)"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["python3", "-Wc", "print('hi')"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["python3", "-Xc", "print('hi')"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["find", ".", "-execute", "id"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["ruby", "-EUTF-8", "script.rb"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["ruby", "-Itest", "script.rb"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["ruby", "-W:deprecatede", "puts 1"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["ruby", "-7pe", "puts 1"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["perl", "-C0e", "say 1"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["perl", "-D0e", "say 1"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["perl", "-me", "say 1"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["perl", "-Me", "say 1"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["perl", "-7pe", "say 1"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["perl", "-0xFFpe", "say 1"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["php", "-F", "filter.php"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["Rscript", "script.R"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["julia", "script.jl"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["elixir", "script.exs"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["elixir", "-eIO.puts(1)"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["iex", "-eIO.puts(1)"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["guile", "script.scm"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["guile", "-c(display 1)"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["guile", "-e(display 1)"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["groovy", "script.groovy"])).toBeNull();
    expect(
      detectInterpreterInlineEvalArgv(["groovy", "-encoding", "UTF-8", "script.groovy"]),
    ).toBeNull();
    expect(
      detectInterpreterInlineEvalArgv(["groovy", "-encoding=UTF-8", "script.groovy"]),
    ).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["scala", "script.scala"])).toBeNull();
    expect(
      detectInterpreterInlineEvalArgv(["scala", "-encoding", "UTF-8", "script.scala"]),
    ).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["scala-cli", "script.scala"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["clojure", "-M", "-m", "app.main"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["clojure", "-e(println 1)"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["raku", "script.raku"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["ghc", "Main.hs"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["ghc", "-exclude-module", "Debug.Trace"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["erl", "-sname", "node"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["erl", "-setcookie", "cookie"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["erl", "-shutdown_time", "1000"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["gdb", "-e", "program"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["gdb", "--command=commands.gdb"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["gdb", "-eix", "early.gdb"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["gdb", "-early-init-command", "early.gdb"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["expect", "script.exp"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["r2", "-e", "bin.cache=true", "program"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["awk", "-f", "script.awk", "data.csv"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["find", ".", "-name", "*.ts"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["xargs", "-0"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["make", "test"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["sed", "-f", "script.sed", "input.txt"])).toBeNull();
    expect(
      detectInterpreterInlineEvalArgv(["sed", "-i", "-f", "script.sed", "input.txt"]),
    ).toBeNull();
    expect(
      detectInterpreterInlineEvalArgv(["sed", "-E", "-f", "script.sed", "input.txt"]),
    ).toBeNull();
  });

  it("matches interpreter-like allowlist patterns", () => {
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/python3")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/python3.13")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("python3.*")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("pypy3.10")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("**/node")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("Rscript")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("/opt/bin/julia")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("**/elixir")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("iex")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("guile3.0")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/groovy")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("scala")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("scala-cli")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("clojure.exe")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("**/clj")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("raku")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("perl6")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("ghci")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("erl")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("gdb")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("expect")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("r2")).toBe(false);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/awk")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("**/gawk")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/mawk")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("nawk")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("**/find")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("xargs.exe")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/gmake")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("**/gsed")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/rg")).toBe(false);
  });
});
