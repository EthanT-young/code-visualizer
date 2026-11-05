// Included unless the program defines its own ListNode.
#pragma once
struct ListNode {
    int val;
    ListNode *next;
    ListNode() : val(0), next(nullptr) {}
    ListNode(int x) : val(x), next(nullptr) {}
    ListNode(int x, ListNode *next) : val(x), next(next) {}
};

// buildList({1, 2, 3}) -> 1 -> 2 -> 3
inline ListNode *buildList(std::initializer_list<int> values) {
    ListNode dummy;
    ListNode *cur = &dummy;
    for (int v : values) cur = cur->next = new ListNode(v);
    return dummy.next;
}
