#include <jni.h>
#include <node.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <unistd.h>

extern "C"
JNIEXPORT jint JNICALL
Java_dz_nrs_cashpro_MainActivity_startNodeWithArguments(
        JNIEnv* env, jobject, jobjectArray javaArgs) {

    if (javaArgs == nullptr || env->GetArrayLength(javaArgs) < 7)
        return -10;

    std::vector<std::string> values;
    const jsize count = env->GetArrayLength(javaArgs);

    for (jsize i = 0; i < count; ++i) {
        auto item = static_cast<jstring>(
            env->GetObjectArrayElement(javaArgs, i));
        if (item == nullptr) return -11;

        const char* chars = env->GetStringUTFChars(item, nullptr);
        if (chars == nullptr) return -12;

        values.emplace_back(chars);
        env->ReleaseStringUTFChars(item, chars);
        env->DeleteLocalRef(item);
    }

    setenv("DATA_DIR", values[2].c_str(), 1);
    setenv("TMPDIR", values[3].c_str(), 1);
    setenv("HOME", values[4].c_str(), 1);
    setenv("INITIAL_ADMIN_PASSWORD", values[6].c_str(), 1);
    setenv("UV_THREADPOOL_SIZE", "4", 0);

    if (chdir(values[5].c_str()) != 0) return -13;

    // Node/libuv expects argv strings in contiguous writable memory.
    const std::string arg0 = "node";
    const std::string arg1 = values[1];
    std::vector<char> buffer;
    buffer.reserve(arg0.size() + arg1.size() + 2);
    buffer.insert(buffer.end(), arg0.begin(), arg0.end());
    buffer.push_back('\0');
    buffer.insert(buffer.end(), arg1.begin(), arg1.end());
    buffer.push_back('\0');

    char* argv[3];
    argv[0] = buffer.data();
    argv[1] = buffer.data() + arg0.size() + 1;
    argv[2] = nullptr;

    return static_cast<jint>(node::Start(2, argv));
}
