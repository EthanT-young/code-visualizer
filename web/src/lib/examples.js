// Example programs for each language, plus how each language is edited and run.

export const LANGUAGES = {
  java: { label: 'Java', server: true, nil: 'null' },
  cpp: { label: 'C++', server: true, nil: 'nullptr' },
  python: { label: 'Python', server: false, nil: 'None' },
};

export const EXAMPLES = {
  java: [
    {
      name: 'Two Sum (hash map)',
      code: `class Solution {
    public int[] twoSum(int[] nums, int target) {
        Map<Integer, Integer> seen = new HashMap<>();
        for (int i = 0; i < nums.length; i++) {
            int need = target - nums[i];
            if (seen.containsKey(need)) {
                return new int[]{seen.get(need), i};
            }
            seen.put(nums[i], i);
        }
        return new int[0];
    }
}

public class Main {
    public static void main(String[] args) {
        int[] answer = new Solution().twoSum(new int[]{2, 7, 11, 15}, 9);
        System.out.println(Arrays.toString(answer));
    }
}
`,
    },
    {
      name: 'Binary search (two pointers)',
      code: `class Solution {
    public int search(int[] nums, int target) {
        int lo = 0, hi = nums.length - 1;
        while (lo <= hi) {
            int mid = lo + (hi - lo) / 2;
            if (nums[mid] == target) {
                return mid;
            } else if (nums[mid] < target) {
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return -1;
    }
}

public class Main {
    public static void main(String[] args) {
        System.out.println(new Solution().search(new int[]{-1, 0, 3, 5, 9, 12}, 9));
    }
}
`,
    },
    {
      name: 'Longest substring (sliding window)',
      code: `class Solution {
    public int lengthOfLongestSubstring(String s) {
        Map<Character, Integer> lastSeen = new HashMap<>();
        int left = 0, best = 0;
        for (int right = 0; right < s.length(); right++) {
            char ch = s.charAt(right);
            if (lastSeen.containsKey(ch) && lastSeen.get(ch) >= left) {
                left = lastSeen.get(ch) + 1;
            }
            lastSeen.put(ch, right);
            best = Math.max(best, right - left + 1);
        }
        return best;
    }
}

public class Main {
    public static void main(String[] args) {
        System.out.println(new Solution().lengthOfLongestSubstring("abcabcbb"));
    }
}
`,
    },
    {
      name: 'Reverse a linked list',
      code: `// ListNode is provided, like on LeetCode. ListNode.of(1, 2, 3) builds a list.
class Solution {
    public ListNode reverseList(ListNode head) {
        ListNode prev = null, curr = head;
        while (curr != null) {
            ListNode next = curr.next;
            curr.next = prev;
            prev = curr;
            curr = next;
        }
        return prev;
    }
}

public class Main {
    public static void main(String[] args) {
        ListNode head = ListNode.of(1, 2, 3, 4);
        ListNode reversed = new Solution().reverseList(head);
    }
}
`,
    },
    {
      name: 'Max depth of a binary tree (recursion)',
      code: `// TreeNode is provided. TreeNode.of(...) takes LeetCode's level-order format.
class Solution {
    public int maxDepth(TreeNode root) {
        if (root == null) {
            return 0;
        }
        int left = maxDepth(root.left);
        int right = maxDepth(root.right);
        return 1 + Math.max(left, right);
    }
}

public class Main {
    public static void main(String[] args) {
        TreeNode root = TreeNode.of(3, 9, 20, null, null, 15, 7);
        System.out.println(new Solution().maxDepth(root));
    }
}
`,
    },
    {
      name: 'Level order traversal (BFS queue)',
      code: `class Solution {
    public List<List<Integer>> levelOrder(TreeNode root) {
        List<List<Integer>> levels = new ArrayList<>();
        Queue<TreeNode> queue = new ArrayDeque<>();
        if (root != null) {
            queue.offer(root);
        }
        while (!queue.isEmpty()) {
            List<Integer> level = new ArrayList<>();
            for (int size = queue.size(); size > 0; size--) {
                TreeNode node = queue.poll();
                level.add(node.val);
                if (node.left != null) {
                    queue.offer(node.left);
                }
                if (node.right != null) {
                    queue.offer(node.right);
                }
            }
            levels.add(level);
        }
        return levels;
    }
}

public class Main {
    public static void main(String[] args) {
        TreeNode root = TreeNode.of(3, 9, 20, null, null, 15, 7);
        System.out.println(new Solution().levelOrder(root));
    }
}
`,
    },
    {
      name: 'Number of islands (grid DFS)',
      code: `class Solution {
    public int numIslands(char[][] grid) {
        int count = 0;
        for (int r = 0; r < grid.length; r++) {
            for (int c = 0; c < grid[0].length; c++) {
                if (grid[r][c] == '1') {
                    count++;
                    sink(grid, r, c);
                }
            }
        }
        return count;
    }

    private void sink(char[][] grid, int r, int c) {
        if (r < 0 || c < 0 || r >= grid.length || c >= grid[0].length || grid[r][c] != '1') {
            return;
        }
        grid[r][c] = '0';
        sink(grid, r + 1, c);
        sink(grid, r - 1, c);
        sink(grid, r, c + 1);
        sink(grid, r, c - 1);
    }
}

public class Main {
    public static void main(String[] args) {
        char[][] grid = {
            {'1', '1', '0', '0'},
            {'1', '0', '0', '1'},
            {'0', '0', '1', '1'},
        };
        System.out.println(new Solution().numIslands(grid));
    }
}
`,
    },
    {
      name: 'Climbing stairs (memoized recursion)',
      code: `public class Main {
    static int climb(int n, Map<Integer, Integer> memo) {
        if (n <= 2) {
            return n;
        }
        if (!memo.containsKey(n)) {
            memo.put(n, climb(n - 1, memo) + climb(n - 2, memo));
        }
        return memo.get(n);
    }

    public static void main(String[] args) {
        System.out.println(climb(5, new HashMap<>()));
    }
}
`,
    },
    {
      name: 'Bubble sort',
      code: `public class Main {
    static void bubbleSort(int[] arr) {
        int n = arr.length;
        for (int i = 0; i < n; i++) {
            for (int j = 0; j < n - 1 - i; j++) {
                if (arr[j] > arr[j + 1]) {
                    int tmp = arr[j];
                    arr[j] = arr[j + 1];
                    arr[j + 1] = tmp;
                }
            }
        }
    }

    public static void main(String[] args) {
        int[] arr = {5, 1, 4, 2, 8};
        bubbleSort(arr);
        System.out.println(Arrays.toString(arr));
    }
}
`,
    },
    {
      name: 'HackerRank style (reads input)',
      code: `// Reads from the "Program input" box under the editor.
public class Main {
    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int n = in.nextInt();
        int[] scores = new int[n];
        for (int i = 0; i < n; i++) {
            scores[i] = in.nextInt();
        }
        int best = Integer.MIN_VALUE, runnerUp = Integer.MIN_VALUE;
        for (int score : scores) {
            if (score > best) {
                runnerUp = best;
                best = score;
            } else if (score > runnerUp && score < best) {
                runnerUp = score;
            }
        }
        System.out.println(runnerUp);
    }
}
`,
      stdin: '5\n2 3 6 6 5\n',
    },
  ],

  cpp: [
    {
      name: 'Two Sum (hash map)',
      code: `// <bits/stdc++.h> and "using namespace std" are included, like on LeetCode.
class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        unordered_map<int, int> seen;
        for (int i = 0; i < (int)nums.size(); i++) {
            int need = target - nums[i];
            if (seen.count(need)) {
                return {seen[need], i};
            }
            seen[nums[i]] = i;
        }
        return {};
    }
};

int main() {
    vector<int> nums = {2, 7, 11, 15};
    vector<int> answer = Solution().twoSum(nums, 9);
    cout << answer[0] << " " << answer[1] << endl;
}
`,
    },
    {
      name: 'Binary search (two pointers)',
      code: `class Solution {
public:
    int search(vector<int>& nums, int target) {
        int lo = 0, hi = (int)nums.size() - 1;
        while (lo <= hi) {
            int mid = lo + (hi - lo) / 2;
            if (nums[mid] == target) {
                return mid;
            } else if (nums[mid] < target) {
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return -1;
    }
};

int main() {
    vector<int> nums = {-1, 0, 3, 5, 9, 12};
    cout << Solution().search(nums, 9) << endl;
}
`,
    },
    {
      name: 'Longest substring (sliding window)',
      code: `class Solution {
public:
    int lengthOfLongestSubstring(string s) {
        unordered_map<char, int> lastSeen;
        int left = 0, best = 0;
        for (int right = 0; right < (int)s.size(); right++) {
            char ch = s[right];
            if (lastSeen.count(ch) && lastSeen[ch] >= left) {
                left = lastSeen[ch] + 1;
            }
            lastSeen[ch] = right;
            best = max(best, right - left + 1);
        }
        return best;
    }
};

int main() {
    cout << Solution().lengthOfLongestSubstring("abcabcbb") << endl;
}
`,
    },
    {
      name: 'Reverse a linked list',
      code: `// ListNode is provided, like on LeetCode. buildList({1, 2, 3}) builds a list.
class Solution {
public:
    ListNode* reverseList(ListNode* head) {
        ListNode* prev = nullptr;
        ListNode* curr = head;
        while (curr) {
            ListNode* next = curr->next;
            curr->next = prev;
            prev = curr;
            curr = next;
        }
        return prev;
    }
};

int main() {
    ListNode* head = buildList({1, 2, 3, 4});
    ListNode* reversed = Solution().reverseList(head);
}
`,
    },
    {
      name: 'Max depth of a binary tree (recursion)',
      code: `// TreeNode is provided. buildTree takes LeetCode's level-order format; null marks a gap.
class Solution {
public:
    int maxDepth(TreeNode* root) {
        if (!root) {
            return 0;
        }
        int left = maxDepth(root->left);
        int right = maxDepth(root->right);
        return 1 + max(left, right);
    }
};

int main() {
    TreeNode* root = buildTree({3, 9, 20, null, null, 15, 7});
    cout << Solution().maxDepth(root) << endl;
}
`,
    },
    {
      name: 'Level order traversal (BFS queue)',
      code: `class Solution {
public:
    vector<vector<int>> levelOrder(TreeNode* root) {
        vector<vector<int>> levels;
        queue<TreeNode*> q;
        if (root) {
            q.push(root);
        }
        while (!q.empty()) {
            vector<int> level;
            for (int size = (int)q.size(); size > 0; size--) {
                TreeNode* node = q.front();
                q.pop();
                level.push_back(node->val);
                if (node->left) {
                    q.push(node->left);
                }
                if (node->right) {
                    q.push(node->right);
                }
            }
            levels.push_back(level);
        }
        return levels;
    }
};

int main() {
    TreeNode* root = buildTree({3, 9, 20, null, null, 15, 7});
    vector<vector<int>> levels = Solution().levelOrder(root);
}
`,
    },
    {
      name: 'Number of islands (grid DFS)',
      code: `class Solution {
public:
    int numIslands(vector<vector<char>>& grid) {
        int count = 0;
        for (int r = 0; r < (int)grid.size(); r++) {
            for (int c = 0; c < (int)grid[0].size(); c++) {
                if (grid[r][c] == '1') {
                    count++;
                    sink(grid, r, c);
                }
            }
        }
        return count;
    }

private:
    void sink(vector<vector<char>>& grid, int r, int c) {
        if (r < 0 || c < 0 || r >= (int)grid.size() || c >= (int)grid[0].size() || grid[r][c] != '1') {
            return;
        }
        grid[r][c] = '0';
        sink(grid, r + 1, c);
        sink(grid, r - 1, c);
        sink(grid, r, c + 1);
        sink(grid, r, c - 1);
    }
};

int main() {
    vector<vector<char>> grid = {
        {'1', '1', '0', '0'},
        {'1', '0', '0', '1'},
        {'0', '0', '1', '1'},
    };
    cout << Solution().numIslands(grid) << endl;
}
`,
    },
    {
      name: 'Climbing stairs (memoized recursion)',
      code: `int climb(int n, unordered_map<int, int>& memo) {
    if (n <= 2) {
        return n;
    }
    if (!memo.count(n)) {
        memo[n] = climb(n - 1, memo) + climb(n - 2, memo);
    }
    return memo[n];
}

int main() {
    unordered_map<int, int> memo;
    cout << climb(5, memo) << endl;
}
`,
    },
    {
      name: 'Bubble sort',
      code: `void bubbleSort(vector<int>& arr) {
    int n = (int)arr.size();
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < n - 1 - i; j++) {
            if (arr[j] > arr[j + 1]) {
                swap(arr[j], arr[j + 1]);
            }
        }
    }
}

int main() {
    vector<int> arr = {5, 1, 4, 2, 8};
    bubbleSort(arr);
    for (int x : arr) {
        cout << x << " ";
    }
}
`,
    },
    {
      name: 'HackerRank style (reads input)',
      code: `// Reads from the "Program input" box under the editor.
int main() {
    int n;
    cin >> n;
    vector<int> scores(n);
    for (int i = 0; i < n; i++) {
        cin >> scores[i];
    }
    int best = INT_MIN, runnerUp = INT_MIN;
    for (int score : scores) {
        if (score > best) {
            runnerUp = best;
            best = score;
        } else if (score > runnerUp && score < best) {
            runnerUp = score;
        }
    }
    cout << runnerUp << endl;
}
`,
      stdin: '5\n2 3 6 6 5\n',
    },
  ],

  python: [
    {
      name: 'Two Sum (hash map)',
      code: `class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        seen = {}
        for i, num in enumerate(nums):
            need = target - num
            if need in seen:
                return [seen[need], i]
            seen[num] = i
        return []

print(Solution().twoSum([2, 7, 11, 15], 9))
`,
    },
    {
      name: 'Binary search (two pointers)',
      code: `class Solution:
    def search(self, nums: List[int], target: int) -> int:
        lo, hi = 0, len(nums) - 1
        while lo <= hi:
            mid = (lo + hi) // 2
            if nums[mid] == target:
                return mid
            if nums[mid] < target:
                lo = mid + 1
            else:
                hi = mid - 1
        return -1

print(Solution().search([-1, 0, 3, 5, 9, 12], 9))
`,
    },
    {
      name: 'Longest substring (sliding window)',
      code: `class Solution:
    def lengthOfLongestSubstring(self, s: str) -> int:
        last_seen = {}
        left = best = 0
        for right, ch in enumerate(s):
            if ch in last_seen and last_seen[ch] >= left:
                left = last_seen[ch] + 1
            last_seen[ch] = right
            best = max(best, right - left + 1)
        return best

print(Solution().lengthOfLongestSubstring("abcabcbb"))
`,
    },
    {
      name: 'Reverse a linked list',
      code: `# ListNode is provided, like on LeetCode. build_list([1, 2, 3]) builds a list.
class Solution:
    def reverseList(self, head: Optional[ListNode]) -> Optional[ListNode]:
        prev, curr = None, head
        while curr:
            nxt = curr.next
            curr.next = prev
            prev = curr
            curr = nxt
        return prev

head = build_list([1, 2, 3, 4])
new_head = Solution().reverseList(head)
`,
    },
    {
      name: 'Max depth of a binary tree (recursion)',
      code: `# TreeNode is provided. build_tree takes LeetCode's level-order format.
class Solution:
    def maxDepth(self, root: Optional[TreeNode]) -> int:
        if not root:
            return 0
        left = self.maxDepth(root.left)
        right = self.maxDepth(root.right)
        return 1 + max(left, right)

root = build_tree([3, 9, 20, None, None, 15, 7])
print(Solution().maxDepth(root))
`,
    },
    {
      name: 'Level order traversal (BFS queue)',
      code: `class Solution:
    def levelOrder(self, root: Optional[TreeNode]) -> List[List[int]]:
        levels = []
        queue = deque([root] if root else [])
        while queue:
            level = []
            for _ in range(len(queue)):
                node = queue.popleft()
                level.append(node.val)
                if node.left:
                    queue.append(node.left)
                if node.right:
                    queue.append(node.right)
            levels.append(level)
        return levels

root = build_tree([3, 9, 20, None, None, 15, 7])
print(Solution().levelOrder(root))
`,
    },
    {
      name: 'Number of islands (grid DFS)',
      code: `class Solution:
    def numIslands(self, grid: List[List[str]]) -> int:
        rows, cols = len(grid), len(grid[0])
        count = 0

        def sink(r, c):
            if r < 0 or c < 0 or r >= rows or c >= cols or grid[r][c] != "1":
                return
            grid[r][c] = "0"
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                sink(r + dr, c + dc)

        for r in range(rows):
            for c in range(cols):
                if grid[r][c] == "1":
                    count += 1
                    sink(r, c)
        return count

grid = [
    ["1", "1", "0", "0"],
    ["1", "0", "0", "1"],
    ["0", "0", "1", "1"],
]
print(Solution().numIslands(grid))
`,
    },
    {
      name: 'Climbing stairs (memoized recursion)',
      code: `def climb(n, memo):
    if n <= 2:
        return n
    if n not in memo:
        memo[n] = climb(n - 1, memo) + climb(n - 2, memo)
    return memo[n]

print(climb(5, {}))
`,
    },
    {
      name: 'Bubble sort',
      code: `def bubble_sort(arr):
    n = len(arr)
    for i in range(n):
        for j in range(n - 1 - i):
            if arr[j] > arr[j + 1]:
                arr[j], arr[j + 1] = arr[j + 1], arr[j]
    return arr

print(bubble_sort([5, 1, 4, 2, 8]))
`,
    },
    {
      name: 'HackerRank style (reads input)',
      code: `# Reads from the "Program input" box under the editor.
n = int(input())
scores = list(map(int, input().split()))
best = max(scores)
runner_up = max(x for x in scores if x != best)
print(runner_up)
`,
      stdin: '5\n2 3 6 6 5\n',
    },
  ],
};
