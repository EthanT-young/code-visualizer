// Included unless the program defines its own TreeNode.
#pragma once
struct TreeNode {
    int val;
    TreeNode *left;
    TreeNode *right;
    TreeNode() : val(0), left(nullptr), right(nullptr) {}
    TreeNode(int x) : val(x), left(nullptr), right(nullptr) {}
    TreeNode(int x, TreeNode *left, TreeNode *right) : val(x), left(left), right(right) {}
};

// Marks a missing node in buildTree, like LeetCode's "null".
constexpr int null = INT_MIN;

// buildTree({3, 9, 20, null, null, 15, 7}) using LeetCode's level-order format.
inline TreeNode *buildTree(std::initializer_list<int> values) {
    std::vector<int> v(values);
    if (v.empty() || v[0] == null) return nullptr;
    TreeNode *root = new TreeNode(v[0]);
    std::queue<TreeNode *> q;
    q.push(root);
    size_t i = 1;
    while (!q.empty() && i < v.size()) {
        TreeNode *node = q.front();
        q.pop();
        if (i < v.size() && v[i] != null) q.push(node->left = new TreeNode(v[i]));
        i++;
        if (i < v.size() && v[i] != null) q.push(node->right = new TreeNode(v[i]));
        i++;
    }
    return root;
}
