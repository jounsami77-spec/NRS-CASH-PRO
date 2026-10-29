cmake_minimum_required(VERSION 3.22.1)
project(nrsnode LANGUAGES CXX)

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES
    IMPORTED_LOCATION
    "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so")

add_library(nrsnode SHARED native-lib.cpp)

target_include_directories(nrsnode PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/include/node")

find_library(log-lib log)
find_library(android-lib android)

target_link_libraries(nrsnode PRIVATE node ${log-lib} ${android-lib})
