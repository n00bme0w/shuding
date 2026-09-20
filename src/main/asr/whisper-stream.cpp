#include "whisper.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

constexpr uint32_t RESET = 0;
constexpr uint32_t FINISH = 0xffffffffu;
constexpr int SAMPLE_RATE = 16000;
// Whisper needs several seconds of Chinese speech to establish reliable context.
// Short independent windows are prone to high-frequency hallucinations.
constexpr size_t PARTIAL_AFTER_SAMPLES = SAMPLE_RATE * 4;
constexpr size_t PARTIAL_INTERVAL_SAMPLES = SAMPLE_RATE;
constexpr size_t MAX_UTTERANCE_SAMPLES = SAMPLE_RATE * 28;
constexpr size_t FINAL_PADDING_SAMPLES = SAMPLE_RATE / 3;

static std::string json_escape(const std::string & value) {
    std::string result;
    for (const char ch : value) {
        if (ch == '\\' || ch == '"') result += '\\';
        if (ch == '\n') result += "\\n";
        else if (ch != '\r') result += ch;
    }
    return result;
}

static std::string transcribe(whisper_context * ctx, const std::vector<float> & audio) {
    if (audio.empty()) return "";
    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.print_progress = false;
    params.print_realtime = false;
    params.print_timestamps = false;
    params.print_special = false;
    params.no_context = true;
    params.no_timestamps = true;
    params.single_segment = false;
    params.max_tokens = 0;
    params.n_threads = 8;
    params.language = "zh";
    if (whisper_full(ctx, params, audio.data(), audio.size()) != 0) return "";
    std::string text;
    for (int index = 0; index < whisper_full_n_segments(ctx); ++index) text += whisper_full_get_segment_text(ctx, index);
    const auto first = text.find_first_not_of(" \t\n\r");
    const auto last = text.find_last_not_of(" \t\n\r");
    return first == std::string::npos ? "" : text.substr(first, last - first + 1);
}

static std::string transcribe_final(whisper_context * ctx, const std::vector<float> & audio) {
    if (audio.empty()) return "";
    auto padded = audio;
    padded.insert(padded.end(), FINAL_PADDING_SAMPLES, 0.0f);
    return transcribe(ctx, padded);
}

static void emit(const char * type, const std::string & text) {
    std::cout << "{\"type\":\"" << type << "\",\"text\":\"" << json_escape(text) << "\"}" << std::endl;
}

int main(int argc, char ** argv) {
    if (argc != 2) return 1;
    ggml_backend_load_all();
    whisper_context_params context_params = whisper_context_default_params();
    context_params.use_gpu = true;
    context_params.flash_attn = true;
    whisper_context * ctx = whisper_init_from_file_with_params(argv[1], context_params);
    if (!ctx) return 2;

    // Keep a whole utterance for each preview. The renderer replaces the preview
    // in place, so nothing unstable becomes part of the user's draft.
    std::vector<float> pending;
    size_t next_partial_at = PARTIAL_AFTER_SAMPLES;
    uint32_t count = 0;
    while (std::cin.read(reinterpret_cast<char *>(&count), sizeof(count))) {
        if (count == RESET) {
            pending.clear();
            next_partial_at = PARTIAL_AFTER_SAMPLES;
            continue;
        }
        if (count == FINISH) {
            const auto text = transcribe_final(ctx, pending);
            // The renderer also needs an explicit completion signal for a silent
            // press-to-talk gesture, otherwise it remains in "transcribing".
            emit("final", text);
            pending.clear();
            next_partial_at = PARTIAL_AFTER_SAMPLES;
            continue;
        }
        if (count > SAMPLE_RATE * 10) return 3;
        const auto offset = pending.size();
        pending.resize(offset + count);
        if (!std::cin.read(reinterpret_cast<char *>(pending.data() + offset), count * sizeof(float))) break;
        if (pending.size() >= MAX_UTTERANCE_SAMPLES) {
            const auto text = transcribe_final(ctx, pending);
            if (!text.empty()) emit("commit", text);
            pending.clear();
            next_partial_at = PARTIAL_AFTER_SAMPLES;
        } else if (pending.size() >= next_partial_at) {
            const auto text = transcribe(ctx, pending);
            if (!text.empty()) emit("partial", text);
            next_partial_at = pending.size() + PARTIAL_INTERVAL_SAMPLES;
        }
    }
    whisper_free(ctx);
    return 0;
}
