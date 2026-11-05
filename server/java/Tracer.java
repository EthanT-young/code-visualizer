import com.sun.jdi.*;
import com.sun.jdi.connect.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;

import javax.tools.*;
import java.io.*;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.regex.*;

/**
 * Traces a Java program line by line with JDI and prints the trace as JSON.
 * Output format matches the Python tracer, so the browser renders both the same way.
 *
 * Usage: java Tracer <workdir>   (workdir contains source.txt and stdin.txt)
 */
public class Tracer {
    static final int MAX_STEPS = 3000;
    static final int MAX_ITEMS = 80;
    static final int MAX_OBJECTS = 300;
    static final int MAX_OUTPUT = 100_000;
    static final long TIME_BUDGET_MS = 10_000;
    static final String[] JDK_PACKAGES = {"java.*", "javax.*", "jdk.*", "sun.*", "com.sun.*"};

    static final String IMPORTS = "import java.util.*; import java.util.function.*; import java.util.stream.*; ";

    static final String LIST_NODE = """
        class ListNode {
            int val;
            ListNode next;
            ListNode() {}
            ListNode(int val) { this.val = val; }
            ListNode(int val, ListNode next) { this.val = val; this.next = next; }
            static ListNode of(int... values) {
                ListNode dummy = new ListNode(), cur = dummy;
                for (int v : values) { cur.next = new ListNode(v); cur = cur.next; }
                return dummy.next;
            }
            @Override public String toString() { return "ListNode(" + val + ")"; }
        }
        """;

    static final String TREE_NODE = """
        class TreeNode {
            int val;
            TreeNode left;
            TreeNode right;
            TreeNode() {}
            TreeNode(int val) { this.val = val; }
            TreeNode(int val, TreeNode left, TreeNode right) { this.val = val; this.left = left; this.right = right; }
            static TreeNode of(Integer... values) {
                if (values.length == 0 || values[0] == null) return null;
                TreeNode root = new TreeNode(values[0]);
                java.util.ArrayDeque<TreeNode> queue = new java.util.ArrayDeque<>();
                queue.add(root);
                int i = 1;
                while (!queue.isEmpty() && i < values.length) {
                    TreeNode node = queue.poll();
                    if (i < values.length && values[i] != null) { node.left = new TreeNode(values[i]); queue.add(node.left); }
                    i++;
                    if (i < values.length && values[i] != null) { node.right = new TreeNode(values[i]); queue.add(node.right); }
                    i++;
                }
                return root;
            }
            @Override public String toString() { return "TreeNode(" + val + ")"; }
        }
        """;

    // ------------------------------------------------------------------ state

    final Path work;
    String userFile;
    final Set<String> helperClasses = new HashSet<>();
    final List<Map<String, Object>> steps = new ArrayList<>();
    final Map<String, Object> result = new LinkedHashMap<>();
    final StringBuilder stdout = new StringBuilder();
    boolean outputCut = false;
    final StringBuilder stderr = new StringBuilder();
    final Map<Long, Integer> ids = new HashMap<>();
    final List<ObjectReference> keep = new ArrayList<>();
    final List<ReferenceType> userTypes = new ArrayList<>();
    Process process;
    String mainClass;
    boolean finished = false;

    Tracer(Path work) {
        this.work = work;
        result.put("ok", true);
        result.put("steps", steps);
        result.put("stdout", "");
        result.put("error", null);
        result.put("line", null);
        result.put("limit", false);
    }

    public static void main(String[] args) throws Exception {
        Tracer t = new Tracer(Paths.get(args[0]));
        try {
            t.run();
        } catch (Throwable e) {
            t.fail("Tracer error: " + e, null);
        }
        t.result.put("stdout", t.stdout + (t.outputCut ? "\n[output truncated]" : ""));
        PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
        out.print(Json.write(t.result));
        out.flush();
        System.exit(0);
    }

    void fail(String message, Integer line) {
        result.put("ok", false);
        result.put("error", message);
        result.put("line", line);
    }

    // ------------------------------------------------------------------ compile

    void run() throws Exception {
        String code = Files.readString(work.resolve("source.txt"));
        String stdin = Files.exists(work.resolve("stdin.txt")) ? Files.readString(work.resolve("stdin.txt")) : "";

        Matcher pub = Pattern.compile("(?m)^\\s*public\\s+(?:final\\s+|abstract\\s+)*(?:class|interface|enum|record)\\s+(\\w+)").matcher(code);
        String className = pub.find() ? pub.group(1) : "Main";
        userFile = className + ".java";

        // Same line as the user's first line, so line numbers don't shift.
        String source = code.contains("package ") ? code : IMPORTS + code;
        Path src = work.resolve("src");
        Path out = work.resolve("classes");
        Files.createDirectories(src);
        Files.createDirectories(out);
        List<File> files = new ArrayList<>();
        files.add(write(src.resolve(userFile), source));
        if (!Pattern.compile("\\b(class|record)\\s+ListNode\\b").matcher(code).find()) {
            files.add(write(src.resolve("ListNode.java"), LIST_NODE));
            helperClasses.add("ListNode");
        }
        if (!Pattern.compile("\\b(class|record)\\s+TreeNode\\b").matcher(code).find()) {
            files.add(write(src.resolve("TreeNode.java"), TREE_NODE));
            helperClasses.add("TreeNode");
        }

        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        try (StandardJavaFileManager fm = compiler.getStandardFileManager(diags, Locale.US, StandardCharsets.UTF_8)) {
            List<String> options = List.of("-g", "-d", out.toString(), "-encoding", "UTF-8", "-proc:none", "-nowarn", "-Xlint:none");
            boolean ok = compiler.getTask(null, fm, diags, options, null, fm.getJavaFileObjectsFromFiles(files)).call();
            if (!ok) {
                for (Diagnostic<? extends JavaFileObject> d : diags.getDiagnostics()) {
                    if (d.getKind() != Diagnostic.Kind.ERROR) continue;
                    String msg = d.getMessage(Locale.US).split("\n")[0];
                    fail("Compile error: " + msg, d.getLineNumber() > 0 ? (int) d.getLineNumber() : null);
                    return;
                }
                fail("Compile error", null);
                return;
            }
        }

        String mainClass = findMain(out, className);
        if (mainClass == null) {
            fail("No main method found. Add `public static void main(String[] args)` that calls your solution, like the examples.", null);
            return;
        }
        this.mainClass = mainClass;
        trace(mainClass, out, stdin);
    }

    static File write(Path p, String s) throws IOException {
        Files.writeString(p, s, StandardCharsets.UTF_8);
        return p.toFile();
    }

    String findMain(Path out, String preferred) throws Exception {
        List<String> names = new ArrayList<>();
        try (var walk = Files.walk(out)) {
            walk.filter(p -> p.toString().endsWith(".class")).forEach(p -> {
                String rel = out.relativize(p).toString();
                names.add(rel.substring(0, rel.length() - 6).replace(File.separatorChar, '.'));
            });
        }
        names.sort(Comparator.comparing((String n) -> !n.equals(preferred)).thenComparing(n -> n));
        try (URLClassLoader loader = new URLClassLoader(new URL[]{out.toUri().toURL()}, null)) {
            for (String n : names) {
                try {
                    Class<?> c = Class.forName(n, false, loader);
                    var m = c.getDeclaredMethod("main", String[].class);
                    if (java.lang.reflect.Modifier.isStatic(m.getModifiers())) return n;
                } catch (NoSuchMethodException | LinkageError ignored) {
                    // not a main class
                }
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ tracing

    void trace(String mainClass, Path classes, String stdin) throws Exception {
        LaunchingConnector connector = Bootstrap.virtualMachineManager().defaultConnector();
        Map<String, Connector.Argument> args = connector.defaultArguments();
        args.get("main").setValue(mainClass);
        args.get("options").setValue("-cp " + classes + " -Xmx256m -Xss32m -XX:+UseSerialGC -XX:TieredStopAtLevel=1 -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8");
        VirtualMachine vm = connector.launch(args);
        process = vm.process();
        try (OutputStream in = process.getOutputStream()) {
            in.write(stdin.getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) {
            // program may not read stdin
        }

        EventRequestManager erm = vm.eventRequestManager();
        ClassPrepareRequest prep = erm.createClassPrepareRequest();
        for (String p : JDK_PACKAGES) prep.addClassExclusionFilter(p);
        prep.enable();

        long deadline = System.currentTimeMillis() + TIME_BUDGET_MS;
        EventQueue queue = vm.eventQueue();
        boolean running = true;
        ThreadReference mainThread = null;

        try {
            while (running) {
                if (System.currentTimeMillis() > deadline) {
                    result.put("limit", true);
                    result.put("error", "Stopped after " + TIME_BUDGET_MS / 1000 + " seconds. Is there an infinite loop? Showing the steps recorded so far.");
                    vm.exit(1);
                    break;
                }
                EventSet set = queue.remove(50);
                drainOutput();
                if (set == null) continue;
                boolean stop = false;
                for (Event e : set) {
                    if (e instanceof VMDeathEvent || e instanceof VMDisconnectEvent) {
                        running = false;
                    } else if (e instanceof ClassPrepareEvent cpe) {
                        onClassPrepare(cpe, mainClass, erm);
                    } else if (e instanceof BreakpointEvent be) {
                        mainThread = be.thread();
                        startStepping(erm, mainThread);
                        stop = record(mainThread, "line", be.location().lineNumber(), null, null);
                    } else if (e instanceof StepEvent se) {
                        if (isUser(se.location()) && !isImplicitConstructor(se.location().method())) {
                            stop = record(se.thread(), "line", se.location().lineNumber(), null, null);
                        }
                    } else if (e instanceof MethodExitEvent me) {
                        stop = onMethodExit(me);
                    } else if (e instanceof ExceptionEvent ee) {
                        stop = onException(ee);
                    }
                    if (stop) break;
                }
                if (stop) {
                    vm.exit(1);
                    break;
                }
                if (running) set.resume();
            }
        } catch (VMDisconnectedException ignored) {
            // program finished
        }

        finishOutput();
        if (!finished && !Boolean.TRUE.equals(result.get("limit")) && Boolean.TRUE.equals(result.get("ok"))) {
            String err = stderr.toString().trim();
            if (!err.isEmpty() && steps.isEmpty()) fail(err.split("\n")[0], null);
        }
    }

    void onClassPrepare(ClassPrepareEvent e, String mainClass, EventRequestManager erm) {
        ReferenceType rt = e.referenceType();
        if (isUserType(rt)) userTypes.add(rt);
        if (!rt.name().equals(mainClass)) return;
        for (Method m : rt.methodsByName("main")) {
            if (m.isStatic() && m.signature().equals("([Ljava/lang/String;)V") && m.location() != null) {
                BreakpointRequest bp = erm.createBreakpointRequest(m.location());
                bp.addCountFilter(1);
                bp.enable();
            }
        }
    }

    void startStepping(EventRequestManager erm, ThreadReference thread) {
        StepRequest step = erm.createStepRequest(thread, StepRequest.STEP_LINE, StepRequest.STEP_INTO);
        excludeNonUser(step::addClassExclusionFilter);
        step.enable();

        MethodExitRequest exit = erm.createMethodExitRequest();
        exit.addThreadFilter(thread);
        excludeNonUser(exit::addClassExclusionFilter);
        exit.enable();

        ExceptionRequest ex = erm.createExceptionRequest(null, true, true);
        ex.addThreadFilter(thread);
        ex.enable();
    }

    void excludeNonUser(java.util.function.Consumer<String> exclude) {
        for (String p : JDK_PACKAGES) exclude.accept(p);
        for (String h : helperClasses) exclude.accept(h);
    }

    boolean onMethodExit(MethodExitEvent e) {
        Method m = e.method();
        if (!isUser(e.location())) return false;
        String name = m.name();
        if (name.equals("<init>") || name.equals("<clinit>")) return false;
        if (name.equals("main") && m.isStatic() && m.declaringType().name().equals(mainClass)) {
            // main is finishing: the final "done" step keeps main's variables on screen.
            finished = true;
            record(e.thread(), "done", e.location().lineNumber(), null, null);
            return false;
        }
        Value rv = e.returnValue();
        boolean isVoid = rv == null || rv instanceof VoidValue;
        return record(e.thread(), "return", e.location().lineNumber(), isVoid ? null : rv, null);
    }

    boolean onException(ExceptionEvent e) {
        ObjectReference ex = e.exception();
        String message = ex.referenceType().name().replaceFirst("^java\\.lang\\.", "");
        Value detail = getField(ex, "detailMessage");
        if (detail instanceof StringReference s) message += ": " + s.value();
        Integer line = null;
        try {
            for (StackFrame f : e.thread().frames()) {
                if (isUser(f.location())) {
                    line = f.location().lineNumber();
                    break;
                }
            }
        } catch (IncompatibleThreadStateException ignored) {
            // no frames
        }
        if (e.catchLocation() == null) {
            // Uncaught: the program is about to crash. Record the state as the final step.
            fail(message, line);
            record(e.thread(), "error", line == null ? -1 : line, null, message);
            finished = true;
            return true;
        }
        if (isUser(e.location())) {
            return record(e.thread(), "exception", e.location().lineNumber(), null, message);
        }
        return false;
    }

    /** Default constructors the compiler generated: stepping into them is noise. */
    static boolean isImplicitConstructor(Method m) {
        if (!m.name().equals("<init>") || !m.argumentTypeNames().isEmpty()) return false;
        try {
            return m.allLineLocations().stream().map(Location::lineNumber).distinct().count() <= 1;
        } catch (AbsentInformationException e) {
            return true;
        }
    }

    // ------------------------------------------------------------------ snapshots

    boolean isUser(Location loc) {
        try {
            return loc != null && loc.sourceName().equals(userFile);
        } catch (AbsentInformationException e) {
            return false;
        }
    }

    boolean isUserType(ReferenceType rt) {
        try {
            return rt.sourceName().equals(userFile);
        } catch (AbsentInformationException e) {
            return false;
        }
    }

    /** Records a step. Returns true when the step limit is hit. */
    boolean record(ThreadReference thread, String event, int line, Value ret, String exc) {
        if (steps.size() >= MAX_STEPS) {
            result.put("limit", true);
            result.put("error", "Stopped after " + MAX_STEPS + " steps. Is there an infinite loop? Showing the first " + MAX_STEPS + " steps.");
            return true;
        }
        drainOutput();
        Map<String, Object> heap = new LinkedHashMap<>();
        Deque<ObjectReference> pending = new ArrayDeque<>();
        List<Object> stack = new ArrayList<>();

        List<Object> statics = new ArrayList<>();
        for (ReferenceType rt : userTypes) {
            for (Field f : rt.fields()) {
                if (!f.isStatic() || f.isSynthetic() || f.isFinal()) continue;
                try {
                    statics.add(List.of(simpleName(rt.name()) + "." + f.name(), encode(rt.getValue(f), heap, pending)));
                } catch (Exception ignored) {
                    // class not initialized yet
                }
            }
        }
        if (!statics.isEmpty()) stack.add(frame("Static fields", null, statics));

        try {
            List<StackFrame> frames = new ArrayList<>(thread.frames());
            Collections.reverse(frames);
            for (StackFrame f : frames) {
                Location loc = f.location();
                if (!isUser(loc)) continue;
                List<Object> vars = new ArrayList<>();
                ObjectReference self = f.thisObject();
                if (self != null && hasInstanceFields(self)) vars.add(List.of("this", encode(self, heap, pending)));
                try {
                    for (LocalVariable lv : f.visibleVariables()) {
                        Value val = f.getValue(lv);
                        // Hide main's empty `String[] args`.
                        if (lv.name().equals("args") && val instanceof ArrayReference a && a.length() == 0 && loc.method().name().equals("main")) continue;
                        vars.add(List.of(lv.name(), encode(val, heap, pending)));
                    }
                } catch (AbsentInformationException ignored) {
                    // compiled without -g
                }
                stack.add(frame(methodLabel(loc.method()), loc.lineNumber(), vars));
            }
        } catch (IncompatibleThreadStateException ignored) {
            // thread not suspended
        }

        Map<String, Object> step = new LinkedHashMap<>();
        step.put("line", line > 0 ? line : null);
        step.put("event", event);
        step.put("stack", stack);
        step.put("out", stdout.length());
        if (ret != null) step.put("ret", encode(ret, heap, pending));
        if (exc != null) step.put("exc", exc);
        drain(heap, pending);
        step.put("heap", heap);
        // Returning from library code re-reports the same line; skip it if nothing changed.
        if (!steps.isEmpty() && event.equals("line")) {
            Map<String, Object> prev = steps.get(steps.size() - 1);
            if ("line".equals(prev.get("event")) && Objects.equals(prev.get("line"), step.get("line"))
                    && Objects.equals(prev.get("out"), step.get("out"))
                    && Json.write(prev.get("stack")).equals(Json.write(stack))
                    && Json.write(prev.get("heap")).equals(Json.write(heap))) {
                return false;
            }
        }
        steps.add(step);
        return false;
    }

    static Map<String, Object> frame(String name, Integer line, List<Object> vars) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", name);
        if (line != null) m.put("line", line);
        m.put("vars", vars);
        return m;
    }

    static String methodLabel(Method m) {
        String n = m.name();
        if (n.equals("<init>")) return simpleName(m.declaringType().name());
        if (n.equals("<clinit>")) return "static init";
        if (n.startsWith("lambda$")) return "lambda";
        return n;
    }

    static String simpleName(String name) {
        String s = name.substring(name.lastIndexOf('.') + 1);
        return s.substring(s.lastIndexOf('$') + 1);
    }

    static boolean hasInstanceFields(ObjectReference o) {
        for (Field f : o.referenceType().allFields()) {
            if (!f.isStatic() && !f.isSynthetic()) return true;
        }
        return false;
    }

    // ------------------------------------------------------------------ value encoding

    static Map<String, Object> prim(String kind, String repr) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("k", kind);
        m.put("r", repr);
        return m;
    }

    Map<String, Object> encode(Value v, Map<String, Object> heap, Deque<ObjectReference> pending) {
        if (v == null) return prim("none", "null");
        if (v instanceof BooleanValue b) return prim("bool", String.valueOf(b.value()));
        if (v instanceof CharValue c) {
            Map<String, Object> m = prim("str", "'" + c.value() + "'");
            m.put("s", String.valueOf(c.value()));
            return m;
        }
        if (v instanceof IntegerValue || v instanceof LongValue || v instanceof ShortValue || v instanceof ByteValue) {
            long n = ((PrimitiveValue) v).longValue();
            Map<String, Object> m = prim("int", Long.toString(n));
            if (Math.abs(n) < (1L << 53)) m.put("n", n);
            return m;
        }
        if (v instanceof FloatValue f) return prim("float", Float.toString(f.value()));
        if (v instanceof DoubleValue d) return prim("float", Double.toString(d.value()));
        if (v instanceof StringReference s) {
            String str = s.value();
            Map<String, Object> m = prim("str", Json.quote(str.length() > 120 ? str.substring(0, 119) + "…" : str));
            if (str.length() <= MAX_ITEMS) m.put("s", str);
            return m;
        }
        if (v instanceof ObjectReference o) {
            String cn = o.referenceType().name();
            switch (cn) {
                case "java.lang.Integer", "java.lang.Long", "java.lang.Short", "java.lang.Byte",
                     "java.lang.Character", "java.lang.Boolean", "java.lang.Double", "java.lang.Float":
                    return encode(getField(o, "value"), heap, pending);
                default:
                    break;
            }
            int id = idFor(o);
            String key = Integer.toString(id);
            if (!heap.containsKey(key) && heap.size() < MAX_OBJECTS) {
                heap.put(key, null);
                pending.add(o);
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("k", "ref");
            m.put("id", id);
            return m;
        }
        return prim("other", String.valueOf(v));
    }

    int idFor(ObjectReference o) {
        return ids.computeIfAbsent(o.uniqueID(), k -> {
            keep.add(o);
            return ids.size() + 1;
        });
    }

    void drain(Map<String, Object> heap, Deque<ObjectReference> pending) {
        while (!pending.isEmpty()) {
            ObjectReference o = pending.pop();
            Map<String, Object> obj;
            try {
                obj = encodeObject(o, heap, pending);
            } catch (Exception e) {
                obj = new LinkedHashMap<>();
                obj.put("t", "other");
                obj.put("cls", simpleName(o.referenceType().name()));
                obj.put("r", simpleName(o.referenceType().name()));
            }
            heap.put(Integer.toString(idFor(o)), obj);
        }
    }

    static Value getField(ObjectReference o, String name) {
        Field f = o.referenceType().fieldByName(name);
        return f == null ? null : o.getValue(f);
    }

    static int intField(ObjectReference o, String name) {
        Value v = getField(o, name);
        return v instanceof PrimitiveValue p ? p.intValue() : 0;
    }

    Map<String, Object> seq(String type, String cls, List<Value> items, int len, Map<String, Object> heap, Deque<ObjectReference> pending) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", type);
        m.put("cls", cls);
        m.put("len", len);
        List<Object> out = new ArrayList<>();
        for (Value v : items) out.add(encode(v, heap, pending));
        m.put("items", out);
        return m;
    }

    Map<String, Object> dict(String cls, List<Value[]> entries, int len, Map<String, Object> heap, Deque<ObjectReference> pending) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "dict");
        m.put("cls", cls);
        m.put("len", len);
        List<Object> out = new ArrayList<>();
        for (Value[] kv : entries) out.add(List.of(encode(kv[0], heap, pending), encode(kv[1], heap, pending)));
        m.put("entries", out);
        return m;
    }

    static List<Value> arraySlice(Value arr, int from, int count) {
        if (!(arr instanceof ArrayReference a) || count <= 0) return new ArrayList<>();
        int n = Math.min(count, a.length() - from);
        return n <= 0 ? new ArrayList<>() : new ArrayList<>(a.getValues(from, n));
    }

    List<Value[]> hashEntries(ObjectReference map) {
        List<Value[]> out = new ArrayList<>();
        Value head = getField(map, "head");
        if (head != null || map.referenceType().name().equals("java.util.LinkedHashMap")) {
            // LinkedHashMap: insertion order through "after" links.
            for (Value n = head; n instanceof ObjectReference node && out.size() < MAX_ITEMS; n = getField(node, "after")) {
                out.add(new Value[]{getField(node, "key"), getField(node, "value")});
            }
            return out;
        }
        Value table = getField(map, "table");
        if (!(table instanceof ArrayReference buckets)) return out;
        for (Value b : buckets.getValues()) {
            for (Value n = b; n instanceof ObjectReference node && out.size() < MAX_ITEMS; n = getField(node, "next")) {
                out.add(new Value[]{getField(node, "key"), getField(node, "value")});
            }
            if (out.size() >= MAX_ITEMS) break;
        }
        return out;
    }

    List<Value[]> treeEntries(ObjectReference map) {
        List<Value[]> out = new ArrayList<>();
        Deque<ObjectReference> stack = new ArrayDeque<>();
        Value cur = getField(map, "root");
        while ((cur instanceof ObjectReference || !stack.isEmpty()) && out.size() < MAX_ITEMS) {
            while (cur instanceof ObjectReference node) {
                stack.push(node);
                cur = getField(node, "left");
            }
            ObjectReference node = stack.pop();
            out.add(new Value[]{getField(node, "key"), getField(node, "value")});
            cur = getField(node, "right");
        }
        return out;
    }

    static List<Value> keys(List<Value[]> entries) {
        List<Value> out = new ArrayList<>();
        for (Value[] kv : entries) out.add(kv[0]);
        return out;
    }

    Map<String, Object> encodeObject(ObjectReference o, Map<String, Object> heap, Deque<ObjectReference> pending) {
        ReferenceType type = o.referenceType();
        String cn = type.name();
        String simple = simpleName(cn);

        if (o instanceof ArrayReference a) {
            String cls = cn.substring(cn.lastIndexOf('.') + 1);
            return seq("list", cls, arraySlice(a, 0, MAX_ITEMS), a.length(), heap, pending);
        }
        switch (cn) {
            case "java.util.ArrayList", "java.util.Arrays$ArrayList" -> {
                Value data = cn.equals("java.util.ArrayList") ? getField(o, "elementData") : getField(o, "a");
                int size = cn.equals("java.util.ArrayList") ? intField(o, "size") : ((ArrayReference) data).length();
                return seq("list", cn.equals("java.util.ArrayList") ? "ArrayList" : "List", arraySlice(data, 0, Math.min(size, MAX_ITEMS)), size, heap, pending);
            }
            case "java.util.Stack", "java.util.Vector" -> {
                int size = intField(o, "elementCount");
                return seq("list", simple, arraySlice(getField(o, "elementData"), 0, Math.min(size, MAX_ITEMS)), size, heap, pending);
            }
            case "java.util.LinkedList" -> {
                List<Value> items = new ArrayList<>();
                for (Value n = getField(o, "first"); n instanceof ObjectReference node && items.size() < MAX_ITEMS; n = getField(node, "next")) {
                    items.add(getField(node, "item"));
                }
                return seq("deque", simple, items, intField(o, "size"), heap, pending);
            }
            case "java.util.ArrayDeque" -> {
                Value els = getField(o, "elements");
                List<Value> items = new ArrayList<>();
                if (els instanceof ArrayReference arr) {
                    int cap = arr.length();
                    int head = intField(o, "head");
                    int tail = intField(o, "tail");
                    int size = ((tail - head) % cap + cap) % cap;
                    for (int i = 0; i < Math.min(size, MAX_ITEMS); i++) items.add(arr.getValue((head + i) % cap));
                    return seq("deque", simple, items, size, heap, pending);
                }
                return seq("deque", simple, items, 0, heap, pending);
            }
            case "java.util.PriorityQueue" -> {
                int size = intField(o, "size");
                return seq("list", "PriorityQueue (heap order)", arraySlice(getField(o, "queue"), 0, Math.min(size, MAX_ITEMS)), size, heap, pending);
            }
            case "java.util.HashMap", "java.util.LinkedHashMap" -> {
                return dict(simple, hashEntries(o), intField(o, "size"), heap, pending);
            }
            case "java.util.TreeMap" -> {
                return dict(simple, treeEntries(o), intField(o, "size"), heap, pending);
            }
            case "java.util.HashSet", "java.util.LinkedHashSet" -> {
                ObjectReference map = (ObjectReference) getField(o, "map");
                return seq("set", simple, keys(hashEntries(map)), intField(map, "size"), heap, pending);
            }
            case "java.util.TreeSet" -> {
                ObjectReference map = (ObjectReference) getField(o, "m");
                if (map.referenceType().name().equals("java.util.TreeMap")) {
                    return seq("set", simple, keys(treeEntries(map)), intField(map, "size"), heap, pending);
                }
            }
            case "java.util.ImmutableCollections$ListN", "java.util.ImmutableCollections$SetN" -> {
                Value els = getField(o, "elements");
                List<Value> items = new ArrayList<>();
                for (Value v : arraySlice(els, 0, MAX_ITEMS)) if (v != null) items.add(v);
                return seq(cn.endsWith("SetN") ? "set" : "list", cn.endsWith("SetN") ? "Set" : "List", items, items.size(), heap, pending);
            }
            case "java.util.ImmutableCollections$List12", "java.util.ImmutableCollections$Set12" -> {
                List<Value> items = new ArrayList<>();
                items.add(getField(o, "e0"));
                Value e1 = getField(o, "e1");
                if (e1 != null && !(e1 instanceof ObjectReference r && r.referenceType().name().equals("java.lang.Object"))) items.add(e1);
                return seq(cn.endsWith("Set12") ? "set" : "list", cn.endsWith("Set12") ? "Set" : "List", items, items.size(), heap, pending);
            }
            case "java.lang.StringBuilder", "java.lang.StringBuffer" -> {
                int count = intField(o, "count");
                Value val = getField(o, "value");
                int coder = intField(o, "coder");
                List<Object> chars = new ArrayList<>();
                if (val instanceof ArrayReference bytes) {
                    int n = Math.min(count, MAX_ITEMS);
                    List<Value> raw = coder == 0 ? arraySlice(bytes, 0, n) : arraySlice(bytes, 0, n * 2);
                    for (int i = 0; i < n; i++) {
                        char ch;
                        if (coder == 0) {
                            ch = (char) (((ByteValue) raw.get(i)).value() & 0xff);
                        } else {
                            int lo = ((ByteValue) raw.get(2 * i)).value() & 0xff;
                            int hi = ((ByteValue) raw.get(2 * i + 1)).value() & 0xff;
                            ch = (char) (lo | (hi << 8));
                        }
                        Map<String, Object> c = prim("str", "'" + ch + "'");
                        c.put("s", String.valueOf(ch));
                        chars.add(c);
                    }
                }
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("t", "list");
                m.put("cls", simple);
                m.put("len", count);
                m.put("items", chars);
                return m;
            }
            default -> { }
        }

        Map<String, Object> m = new LinkedHashMap<>();
        boolean jdk = cn.startsWith("java.") || cn.startsWith("javax.") || cn.startsWith("jdk.") || cn.startsWith("sun.");
        if (cn.contains("$$Lambda")) {
            m.put("t", "func");
            m.put("cls", "lambda");
            m.put("r", "lambda");
            return m;
        }
        if (type instanceof ClassType ct && ct.isEnum()) {
            Value name = getField(o, "name");
            m.put("t", "other");
            m.put("cls", simple);
            m.put("r", name instanceof StringReference s ? simple + "." + s.value() : simple);
            return m;
        }
        boolean entry = cn.endsWith("$Node") || cn.endsWith("$Entry") || cn.endsWith("SimpleEntry") || cn.endsWith("$TreeNode");
        if (jdk && !entry) {
            m.put("t", "other");
            m.put("cls", simple);
            m.put("r", simple);
            return m;
        }
        List<Object> attrs = new ArrayList<>();
        for (Field f : type.allFields()) {
            if (f.isStatic() || f.isSynthetic() || f.name().startsWith("this$")) continue;
            if (entry && !(f.name().equals("key") || f.name().equals("value"))) continue;
            attrs.add(List.of(f.name(), encode(o.getValue(f), heap, pending)));
            if (attrs.size() >= MAX_ITEMS) break;
        }
        m.put("t", "obj");
        m.put("cls", entry ? "Entry" : simple);
        m.put("attrs", attrs);
        return m;
    }

    // ------------------------------------------------------------------ program output

    void drainOutput() {
        if (process == null) return;
        readAvailable(process.getInputStream(), stdout, true);
        readAvailable(process.getErrorStream(), stderr, false);
    }

    void readAvailable(InputStream in, StringBuilder sb, boolean cap) {
        try {
            int n = in.available();
            if (n <= 0) return;
            byte[] buf = in.readNBytes(n);
            String s = new String(buf, StandardCharsets.UTF_8);
            if (cap && sb.length() + s.length() > MAX_OUTPUT) {
                s = s.substring(0, Math.max(0, MAX_OUTPUT - sb.length()));
                outputCut = true;
            }
            sb.append(s);
        } catch (IOException ignored) {
            // stream closed
        }
    }

    void finishOutput() {
        if (process == null) return;
        try {
            process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        drainOutput();
        process.destroyForcibly();
    }

    // ------------------------------------------------------------------ JSON

    static final class Json {
        static String write(Object o) {
            StringBuilder sb = new StringBuilder();
            write(o, sb);
            return sb.toString();
        }

        @SuppressWarnings("unchecked")
        static void write(Object o, StringBuilder sb) {
            if (o == null) {
                sb.append("null");
            } else if (o instanceof String s) {
                sb.append(quote(s));
            } else if (o instanceof Number || o instanceof Boolean) {
                sb.append(o);
            } else if (o instanceof Map<?, ?> m) {
                sb.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> e : m.entrySet()) {
                    if (!first) sb.append(',');
                    first = false;
                    sb.append(quote(String.valueOf(e.getKey()))).append(':');
                    write(e.getValue(), sb);
                }
                sb.append('}');
            } else if (o instanceof List<?> l) {
                sb.append('[');
                for (int i = 0; i < l.size(); i++) {
                    if (i > 0) sb.append(',');
                    write(l.get(i), sb);
                }
                sb.append(']');
            } else {
                sb.append(quote(String.valueOf(o)));
            }
        }

        static String quote(String s) {
            StringBuilder sb = new StringBuilder("\"");
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"' -> sb.append("\\\"");
                    case '\\' -> sb.append("\\\\");
                    case '\n' -> sb.append("\\n");
                    case '\r' -> sb.append("\\r");
                    case '\t' -> sb.append("\\t");
                    default -> {
                        if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                        else sb.append(c);
                    }
                }
            }
            return sb.append('"').toString();
        }
    }
}
