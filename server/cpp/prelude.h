// Force-included before user code (g++ -include). Mirrors LeetCode's C++ environment.
// Precompiled in the Docker image, so it must not depend on per-run macros.
#pragma once
#include <bits/stdc++.h>
using namespace std;

namespace cv_internal {
// Unbuffered output so the visualizer can show what has printed at each step.
struct Unbuffered {
    Unbuffered() {
        std::setvbuf(stdout, nullptr, _IONBF, 0);
        std::cout.setf(std::ios::unitbuf);
    }
};
inline Unbuffered unbuffered_;
}  // namespace cv_internal
