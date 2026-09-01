# Google AI Browser Automation

## Deploy trên Coolify

Repository có sẵn stack hai container trong `docker-compose.coolify.yml`: backend Node.js và Google Chrome Stable worker có extension, Xvfb/noVNC cùng volume giữ phiên đăng nhập Google. Xem hướng dẫn cấu hình secrets, domain và đăng nhập lần đầu tại [`docs/COOLIFY.md`](docs/COOLIFY.md).

Dịch vụ nội bộ nhận job qua HTTP API và dùng Chrome đã đăng nhập để điều khiển Google Flow và Gemini. Extension hiện hỗ trợ tạo ảnh, video và chat:

- text-to-image, một prompt hoặc nhiều prompt tuần tự;
- image-to-image từ một ảnh tham chiếu và nhiều prompt;
- các tỉ lệ `16:9`, `4:3`, `1:1`, `3:4`, `9:16`;
- theo dõi trạng thái job qua API;
- upload kết quả lên S3-compatible storage và trả public URL cho client;
- vẫn tải một bản về máy chạy Chrome để hỗ trợ kiểm tra vận hành;
- Gemini Chat một prompt hoặc batch tuần tự;
- mặc định chủ động chọn Gemini 3.5 Flash Lite, hoặc chọn Gemini 3.1 Pro với `model: "3.1-pro"`;
- trả nội dung trả lời và URL cuộc hội thoại qua API.
- text-to-video và image-to-video 720p bằng Veo 3.1 Lite, chạy tuần tự và trả public S3 URL.

Đây là browser automation, không phải Gemini API chính thức. Giao diện Google Flow thay đổi có thể làm selector cần cập nhật. Chỉ sử dụng với tài khoản và hạn mức mà bạn được phép dùng; không dùng để vượt quota, CAPTCHA hoặc cơ chế chống lạm dụng.

## Tài liệu

- [API reference](docs/API.md)
- [Kiến trúc và luồng dữ liệu](docs/ARCHITECTURE.md)
- [Runbook vận hành và xử lý lỗi](docs/RUNBOOK.md)

## Trạng thái đã kiểm thử

Ngày 30/08/2026 trên Chrome/macOS:

- text-to-image: hoạt động;
- batch 3 prompt: hoạt động tuần tự;
- image-to-image từ URL ảnh: hoạt động;
- image-to-image 3 prompt dùng cùng ảnh gốc: hoạt động, đủ 3/3 file;
- popup chọn file native của macOS có thể vẫn hiện dù upload tiếp tục thành công.

Ngày 31/08/2026 trên Chrome/macOS:

- Gemini Chat với model mặc định: hoạt động;
- Gemini Chat với model `3.1-pro`: hoạt động;
- API nhận được nội dung trả lời và URL cuộc hội thoại.
- text-to-video Veo 3.1 Lite: đã xác nhận thủ công toàn bộ luồng tạo video 8 giây và tải được file MP4 thật; extension nhập prompt bằng sự kiện phím thật từng ký tự vì Flow không chấp nhận chèn DOM/bulk input.

Ngày 01/09/2026 trên Chrome/macOS:

- image-to-video Veo 3.1 Lite: đã xác nhận thủ công luồng ảnh đầu + prompt, không cần ảnh cuối; video xuất hiện trong thư viện và mở được trang chi tiết với media video riêng.

Luồng tiếp tục một cuộc hội thoại bằng `newConversation: false` và `chatUrl` đã được triển khai, nhưng chưa có smoke test riêng trong phiên kiểm thử trên.

## Yêu cầu

- Node.js 18 trở lên và npm;
- Google Chrome;
- tài khoản Google có quyền dùng Flow/Gemini và còn quota/credits;
- một project Flow đã mở được trên Chrome;
- macOS hoặc Linux có giao diện desktop cho Chrome extension worker.

## Quick start

### 1. Cài dependency

```bash
cd /Users/nhannguyen/Documents/ChatGPT/imageai
npm install
```

### 2. Chạy API

Thay khóa ví dụ bằng secret riêng, đủ dài và không commit vào Git:

```bash
cd /Users/nhannguyen/Documents/ChatGPT/imageai
FLOW_API_KEY='replace-with-a-long-random-secret' \
FLOW_WORKER='extension' \
S3_ENDPOINT='https://s3a.schoolsai.work' \
S3_REGION='us-east-1' \
S3_BUCKET='flow-images' \
S3_ACCESS_KEY='service-account-access-key' \
S3_SECRET_KEY='service-account-secret-key' \
S3_PUBLIC_URL='https://s3a.schoolsai.work/flow-images' \
npm run api
```

Mặc định API nghe tại `http://127.0.0.1:8787`.

Kiểm tra:

```bash
curl http://127.0.0.1:8787/health
```

Kết quả mong đợi:

```json
{
  "ok": true,
  "running": false,
  "queued": 0
}
```

### 3. Nạp Chrome extension

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked**.
4. Chọn `/Users/nhannguyen/Documents/ChatGPT/imageai/flow-extension`.
5. Mở extension **Google AI Browser Worker** (tooltip hiện có thể vẫn ghi **Flow Image Worker**).
6. Nhập API URL `http://127.0.0.1:8787`.
7. Nhập đúng `FLOW_API_KEY` đã dùng để chạy server.
8. Giữ Worker ID mặc định, bật **Bật worker**, rồi bấm **Lưu và kiểm tra ngay**.
9. Mở hai tab Google Flow cùng project và một tab `https://gemini.google.com/app`; đăng nhập cùng profile Chrome. Extension giữ riêng một tab ở sidebar **Hình ảnh** và một tab ở sidebar **Video**. Nếu mới mở một tab Flow, extension sẽ tự tạo tab thứ hai khi có job thuộc lane còn lại.

Sau mỗi lần sửa source extension, bấm **Reload** tại `chrome://extensions`. Worker có thể tự reload tab Flow/Gemini nếu content script chưa được inject; refresh tab đang mở một lần nếu muốn kiểm tra bản mới ngay.

### 4. Tạo một ảnh từ text

```bash
export FLOW_CLIENT_KEY='replace-with-a-long-random-secret'

curl -sS -X POST http://127.0.0.1:8787/generate \
  -H "Authorization: Bearer $FLOW_CLIENT_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: image-request-UNIQUE_ID' \
  --data '{
    "worker": "extension",
    "projectUrl": "https://labs.google/fx/vi/tools/flow/project/PROJECT_ID",
    "ratio": "16:9",
    "outputs": 1,
    "prompt": "A cute robot cat in Hoi An at night, cinematic"
  }'
```

API chờ ngắn: nếu xong trả HTTP `200` cùng dữ liệu; nếu chưa xong trả HTTP `202` cùng một `id`. Dùng ID đó để theo dõi:

```bash
curl -sS \
  -H "Authorization: Bearer $FLOW_CLIENT_KEY" \
  http://127.0.0.1:8787/jobs/JOB_ID
```

Job thành công khi `status` là `completed` và `progress` bằng `total`.
`outputs` nhận số nguyên từ `1` đến `4` và là số ảnh Flow tạo cho **mỗi prompt**. Nếu bỏ qua, mặc định là `1`: một prompt tạo đúng một ảnh. Chỉ dùng giá trị lớn hơn 1 khi thực sự muốn nhiều phương án. Client có thể gửi tối đa 100 ảnh trong một job; API giữ job và worker xử lý ngầm tuần tự theo nhóm tiến độ 10 prompt.

Client chỉ gọi POST một lần: nhận HTTP `200` thì dùng dữ liệu ngay; nhận `202` thì lưu `id` và poll `GET /jobs/:id`. Nếu POST bị timeout mạng, gửi lại cùng payload và cùng `Idempotency-Key`; API trả job cũ thay vì tạo thêm job.

### 5. Tạo ba ảnh tuần tự

```bash
curl -sS -X POST http://127.0.0.1:8787/generate \
  -H "Authorization: Bearer $FLOW_CLIENT_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: image-batch-UNIQUE_ID' \
  --data '{
    "worker": "extension",
    "projectUrl": "https://labs.google/fx/vi/tools/flow/project/PROJECT_ID",
    "ratio": "16:9",
    "prompts": [
      "A robotic peacock in a cinematic neon cyberpunk scene at night",
      "A robotic peacock as an elegant Japanese woodblock print at sunrise",
      "A robotic peacock as a detailed miniature diorama with warm studio lighting"
    ]
  }'
```

Extension xử lý tuần tự, mỗi lần chỉ claim một prompt. Không mở nhiều worker dùng chung một tài khoản nếu chưa kiểm soát concurrency.
`prompts.length` là số lượt tạo; `outputs` là số ảnh trong mỗi lượt. Vì vậy 3 prompt với `outputs: 4` có thể trả tối đa 12 URL, theo thứ tự prompt rồi đến ảnh 1–4 của prompt đó.

### 6. Chat Gemini

Nếu bỏ `model`, API và extension chủ động chọn `3.5-flash-lite`. Dùng `3.1-pro` khi muốn extension chủ động chọn Gemini 3.1 Pro:

```bash
curl -sS -X POST http://127.0.0.1:8787/chat \
  -H "Authorization: Bearer $FLOW_CLIENT_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: chat-request-UNIQUE_ID' \
  --data '{
    "model": "3.1-pro",
    "newConversation": true,
    "prompt": "Trả lời đúng một dòng: CHAT_OK"
  }'
```

API lưu job vào Turso và chờ ngắn. Nếu xong nhanh, HTTP `200` chứa luôn `responses[]`; nếu chưa xong, HTTP `202` chứa `id`, `Location` và `Retry-After` (mặc định 600 giây). Client lưu duy nhất `id`, sau 10–20 phút gọi `GET /jobs/:id`. Batch dùng `prompts[]` và được chạy tuần tự trong cùng tab.

Nếu request POST bị ngắt trước khi client nhận `id`, gửi lại đúng payload với cùng `Idempotency-Key`; API trả lại job cũ với `deduplicated: true` và không chạy thêm batch. Sau khi đã có `id`, chỉ dùng GET để kiểm tra trạng thái.

### 7. Image-to-image từ file local

Upload file vào asset store trước:

```bash
ASSET_JSON=$(curl -sS -X POST http://127.0.0.1:8787/assets \
  -H "Authorization: Bearer $FLOW_CLIENT_KEY" \
  -H 'Content-Type: image/jpeg' \
  --data-binary '@/absolute/path/reference.jpg')

printf '%s\n' "$ASSET_JSON"
```

Lấy trường `url` trong response, rồi gửi job:

```bash
curl -sS -X POST http://127.0.0.1:8787/generate \
  -H "Authorization: Bearer $FLOW_CLIENT_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: image-edit-UNIQUE_ID' \
  --data '{
    "worker": "extension",
    "projectUrl": "https://labs.google/fx/vi/tools/flow/project/PROJECT_ID",
    "referenceImageUrl": "http://127.0.0.1:8787/assets/ASSET_NAME.jpg",
    "ratio": "16:9",
    "outputs": 1,
    "prompts": [
      "Transform the reference into a cinematic night scene",
      "Transform the reference into a Japanese woodblock print",
      "Transform the reference into a miniature diorama"
    ]
  }'
```

Image-to-image cũng hỗ trợ `outputs: 1..4` giống text-to-image. Bỏ field này thì mỗi prompt chỉ tạo một ảnh.

Ảnh tham chiếu hiện chỉ hỗ trợ `worker: "extension"`.

### 8. Image-to-video từ file local

Upload ảnh như bước image-to-image, sau đó gọi `/video` với URL nhận được:

```bash
curl -sS -X POST http://127.0.0.1:8787/video \
  -H "Authorization: Bearer $FLOW_CLIENT_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: image-video-UNIQUE_ID' \
  --data '{
    "prompt": "The robotic peacock slowly spreads its glowing tail, smooth camera push in",
    "referenceImageUrl": "http://127.0.0.1:8787/assets/ASSET_NAME.jpg",
    "ratio": "16:9"
  }'
```

Nếu có `referenceImageUrl`, extension chọn **Video → Khung hình** và dùng ảnh làm khung hình đầu. Nếu bỏ field này, extension chọn **Video → Thành phần** để tạo text-to-video. Mỗi prompt tạo đúng một video.

## Kết quả và public URL

Khi S3 được cấu hình, extension chuyển binary ảnh vừa render về API; API upload vào:

```text
flow-images/jobs/<job-id>/<index>-<timestamp>.<format>
```

`GET /jobs/:id` trả URL trực tiếp trong `images`:

```json
{
  "status": "completed",
  "images": [
    "https://s3a.schoolsai.work/flow-images/jobs/JOB_ID/001-1788100000000.png"
  ]
}
```

Bucket policy chỉ cho phép public `s3:GetObject`; upload vẫn cần credential. Extension cũng giữ một bản local, thường tại:

```text
~/Downloads/flow-images/flow-<timestamp>.<format>
```

Ảnh tham chiếu tạm nằm tại:

```text
~/Downloads/flow-images/references/
```

Nếu S3 chưa cấu hình, extension worker mới sẽ báo lỗi thay vì hoàn tất mà không có URL.

## Biến môi trường API

| Biến | Mặc định | Ý nghĩa |
|---|---:|---|
| `FLOW_API_KEY` | rỗng | Bearer token hoặc `X-API-Key`; bắt buộc nên đặt |
| `FLOW_HOST` | `127.0.0.1` | Interface API lắng nghe |
| `FLOW_PORT` | `8787` | Cổng API |
| `FLOW_WORKER` | `playwright` | Worker mặc định; deployment hiện tại nên đặt `extension` |
| `FLOW_MAX_PROMPTS` | `100` | Số prompt tối đa mỗi job |
| `FLOW_MAX_IMAGES_PER_JOB` | `100` | Tổng số ảnh tối đa trong một job (`prompts × outputs`) |
| `FLOW_IMAGE_BATCH_SIZE` | `10` | Kích thước nhóm tiến độ ảnh; nhận 1–10, worker vẫn xử lý từng prompt tuần tự |
| `FLOW_IMAGE_MAX_RETRIES` | `0` | Retry job ảnh; mặc định tắt để tránh ảnh trùng |
| `FLOW_MAX_RETRIES` | `2` | Retry mặc định cho chat/video |
| `FLOW_CLIENT_POLL_AFTER_SECONDS` | `600` | Thời gian client nên chờ trước khi poll lại job đang chạy |
| `FLOW_CHAT_INLINE_WAIT_MS` | `20000` | Thời gian POST chat chờ kết quả; chờ bằng event, không poll Turso |
| `FLOW_IMAGE_INLINE_WAIT_MS` | `2000` | Thời gian POST image chờ kết quả; tối đa 30000 |
| `FLOW_VIDEO_INLINE_WAIT_MS` | `2000` | Thời gian POST video chờ kết quả; tối đa 30000 |
| `FLOW_INLINE_WAIT_MS` | không đặt | Fallback chung tương thích cấu hình cũ; biến riêng theo loại được ưu tiên |
| `FLOW_PROJECT_URL` | trang Flow chung | Project URL mặc định |
| `GEMINI_CHAT_URL` | `https://gemini.google.com/app` | URL Gemini mặc định; có thể là một conversation URL |
| `FLOW_PROFILE` | `.flow-chrome-profile` | Chrome profile cho Playwright worker |
| `S3_ENDPOINT` | rỗng | Endpoint S3-compatible, gồm `https://` |
| `S3_REGION` | `us-east-1` | Region dùng khi ký request |
| `S3_BUCKET` | `flow-images` | Bucket output; phải tồn tại khi không bật quản lý bucket |
| `S3_ACCESS_KEY` | rỗng | Access key của service account |
| `S3_SECRET_KEY` | rỗng | Secret key của service account |
| `S3_PUBLIC_URL` | endpoint + bucket | Public base URL trả cho client |
| `S3_MANAGE_BUCKET` | `false` | `true` chỉ lúc bootstrap để tạo bucket/cập nhật public policy |

## Hai worker có trong source

### Extension worker — khuyên dùng hiện tại

Dùng Chrome thật đã đăng nhập. Hỗ trợ text-to-image, image-to-image và Gemini Chat. Ảnh được upload S3 và tải một bản về máy Chrome; chat trả text cùng conversation URL. Đây là worker đã test thành công.

### Playwright worker — legacy/thử nghiệm

Chạy `flow_automation.mjs` bằng persistent profile. Chỉ hỗ trợ text-to-image trong API hiện tại; ảnh tham chiếu bị API từ chối. UI Flow thay đổi có thể khiến selector cũ không hoạt động.

Chạy trực tiếp:

```bash
npm run flow -- \
  --file prompts.txt \
  --ratio 16:9 \
  --url 'https://labs.google/fx/vi/tools/flow/project/PROJECT_ID'
```

## Giới hạn quan trọng

- Job và queue được lưu bền vững trong Turso. Restart API khôi phục job dở theo lease.
- Asset upload được lưu dưới `.flow-api/assets`, nhưng chưa có TTL/cleanup.
- Extension host permissions hiện chỉ cho API tại localhost/127.0.0.1. Muốn dùng API từ Coolify cần sửa manifest và thiết kế kết nối mạng/TLS.
- Job ảnh mặc định không retry tự động; có thể đặt `maxRetries`, nhưng retry sau khi UI đã bấm Tạo có nguy cơ sinh ảnh trùng.
- `/generate`, `/chat` và `/video` hỗ trợ `Idempotency-Key`; client phải giữ cùng key khi retry cùng một yêu cầu.
- Popup file chooser native có thể còn hiện trên macOS dù upload đã thành công.
- Google có thể thay UI, ngôn ngữ, quota, model hoặc chính sách bất kỳ lúc nào.

## Bảo mật

- API key Google từng được dán vào chat/terminal phải được revoke và tạo lại.
- Không commit API key, cookie, Chrome profile hoặc `.flow-api`.
- Không public port `8787` trực tiếp ra Internet.
- Khi triển khai xa máy Chrome, dùng HTTPS/VPN/Tailscale và secret đủ mạnh.
- Chrome profile chứa phiên đăng nhập Google; xem nó như credential nhạy cảm và không copy tùy tiện.

## Các file chính

```text
flow_api.mjs              HTTP API, queue và trạng thái job
flow_automation.mjs       Playwright worker thử nghiệm
flow-extension/worker.js  Poll API, điều khiển tab, upload/download
flow-extension/flow.js    Tương tác DOM của Google Flow
flow-extension/popup.*    Cấu hình extension
generate_images.py        Client Gemini API riêng, không thuộc Flow worker
docs/                     API, kiến trúc và runbook
```
