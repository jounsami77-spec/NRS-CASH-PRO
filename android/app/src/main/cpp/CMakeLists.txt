cmake_minimum_required(VERSION 3.22.1)
project(nrsnode LANGUAGES CXX)

# Node.js 24 headers require C++20 concepts.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)


add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES
    IMPORTED_LOCATION
    "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so")

add_library(nrsnode SHARED native-lib.cpp)
target_compile_features(nrsnode PRIVATE cxx_std_20)
target_compile_options(nrsnode PRIVATE -std=c++20)

target_include_directories(nrsnode PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/include/node")

find_library(log-lib log)
find_library(android-lib android)

target_link_libraries(nrsnode PRIVATE node ${log-lib} ${android-lib})
