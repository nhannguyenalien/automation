# API reference

Base URL mặc định: `http://127.0.0.1:8787`

Mọi endpoint ngoại trừ `GET /health` yêu cầu xác thực nếu server được chạy với `FLOW_API_KEY`.

```http
Authorization: Bearer <FLOW_API_KEY>
```

Hoặc:

```http
X-API-Key: <FLOW_API_KEY>
```

## Quy ước

- JSON request tối đa 1 MiB.
- Asset ảnh đầu vào tối đa 15 MiB. Output extension: ảnh tối đa 25 MiB, video tối đa 100 MiB.
- MIME output hỗ trợ: `image/jpeg`, `image/png`, `image/webp`, `video/mp4`, `video/webm`.
- Tỉ lệ hỗ trợ: `16:9`, `4:3`, `1:1`, `3:4`, `9:16`.
- Số prompt mặc định tối đa: 100, chỉnh bằng `FLOW_MAX_PROMPTS`.
- Trạng thái job: `queued`, `running`, `completed`, `failed`.

## `GET /health`

Kiểm tra process API. Endpoint này hiện không yêu cầu authentication.

```bash
curl -sS http://127.0.0.1:8787/health
```

```json
{
  "ok": true,
  "running": false,
  "queued": 0,
  "storage": {
    "configured": true,
    "bucket": "flow-images"
  }
}
```

`running` và `queued` chủ yếu phản ánh queue Playwright; không phải số extension worker đang online.

## `POST /assets`

Upload ảnh tham chiếu dạng raw binary.

```bash
curl -sS -X POST http://127.0.0.1:8787/assets \
  -H 'Authorization: Bearer local-test-key' \
  -H 'Content-Type: image/jpeg' \
  --data-binary '@/absolute/path/reference.jpg'
```

Response `201 Created`:

```json
{
  "id": "1788100000000-acde1234abcd5678.jpg",
  "url": "http://127.0.0.1:8787/assets/1788100000000-acde1234abcd5678.jpg",
  "size": 312456,
  "contentType": "image/jpeg"
}
```

Lỗi:

- `400`: file rỗng;
- `415`: MIME không phải JPEG, PNG hoặc WebP;
- `500`: file lớn hơn 15 MiB hoặc lỗi ghi đĩa. Hiện lỗi kích thước đi qua generic error handler nên trả `500`.

## `GET /assets/:name`

Đọc ảnh tham chiếu đã upload. Extension tự thêm authorization khi asset có cùng origin với API URL đã cấu hình.

```bash
curl -sS \
  -H 'Authorization: Bearer local-test-key' \
  http://127.0.0.1:8787/assets/ASSET_NAME.jpg \
  --output downloaded-reference.jpg
```

## Contract chung: trả ngay nếu nhanh, trả job nếu lâu

`POST /generate`, `POST /chat` và `POST /video` dùng cùng một contract:

- API chờ bằng event nội bộ, không poll Turso: chat mặc định 20 giây (`FLOW_CHAT_INLINE_WAIT_MS`), image và video mặc định 2 giây (`FLOW_IMAGE_INLINE_WAIT_MS`, `FLOW_VIDEO_INLINE_WAIT_MS`). Mỗi giá trị tối đa 30 giây.
- Nếu job chuyển sang `completed` hoặc `failed` trong khoảng đó: trả HTTP `200` với trạng thái và dữ liệu cuối cùng.
- Nếu job còn `queued` hoặc `running`: trả HTTP `202`, trường `id`, header `Location: /jobs/<id>` và `Retry-After`.
- Client luôn đọc JSON trước. Nếu `status` là `completed` hoặc `failed` thì dừng; nếu chưa xong, lưu `id` và gọi `GET /jobs/:id` sau.
- Cả ba endpoint đều hỗ trợ `Idempotency-Key`. Nếu POST mất response, retry đúng payload và cùng key sẽ nhận lại job cũ.

Như vậy client không cần chọn trước sync hay async và không cần giữ kết nối 10–20 phút.

Khi worker hoàn tất, request đang chờ được đánh thức ngay. Nếu hết thời gian chờ, API chỉ đọc Turso thêm một lần để tránh race rồi trả `202`. Vì vậy hàng trăm request chờ chat không tạo vòng lặp query theo chu kỳ. `FLOW_INLINE_WAIT_MS` vẫn được hỗ trợ làm fallback chung cho cấu hình cũ; biến riêng theo loại được ưu tiên.

## `POST /generate`

Tạo ảnh. Dùng `prompt` cho một ảnh hoặc `prompts` cho batch; response theo contract chung `200/202` ở trên.

### Request fields

| Field | Type | Bắt buộc | Mô tả |
|---|---|---:|---|
| `prompt` | string | một trong hai | Một prompt |
| `prompts` | string[] | một trong hai | Danh sách prompt chạy tuần tự |
| `worker` | string | không | `extension` hoặc `playwright` |
| `ratio` | string | không | Mặc định `16:9` |
| `outputs` | integer | không | `1`–`4`, mặc định `1`; số ảnh tạo cho mỗi prompt; giá trị lớn hơn 1 chỉ hỗ trợ extension |
| `referenceImageUrl` | string | không | URL HTTP(S) ảnh gốc; chỉ extension |
| `delayMs` | number | không | Tối thiểu 5000; mặc định 15000 |
| `timeoutMs` | number | không | Tối thiểu 30000; mặc định 180000 |
| `maxRetries` | integer | không | `0`–`5`; mặc định `0` cho ảnh để tránh sinh ảnh trùng sau lỗi UI |

Nên gửi header `Idempotency-Key` duy nhất cho mỗi yêu cầu logic. Nếu POST bị timeout mạng, gửi lại đúng payload và cùng key; API trả lại cùng job với `deduplicated: true`. Dùng lại key với payload khác trả HTTP `409`. Nếu cả `prompt` và `prompts` cùng tồn tại, code ưu tiên `prompts`.

### Text-to-image

```bash
curl -sS -X POST http://127.0.0.1:8787/generate \
  -H 'Authorization: Bearer local-test-key' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: image-request-UNIQUE_ID' \
  --data '{
    "worker": "extension",
    "ratio": "16:9",
    "outputs": 1,
    "prompt": "A cinematic robot cat walking in Hoi An"
  }'
```

Mặc định một prompt tạo đúng một ảnh. `prompts[]` quyết định số lượt tạo, còn `outputs` quyết định Flow tạo x1–x4 ảnh trong mỗi lượt. Chỉ đặt `outputs > 1` khi thực sự muốn nhiều phương án. Tổng `prompts.length × outputs` không được vượt quá `FLOW_MAX_IMAGES_PER_JOB` (mặc định 100). API nhận job ngay, giữ queue bền vững và extension xử lý từng prompt tuần tự; `FLOW_IMAGE_BATCH_SIZE` (mặc định 10, nhận 1–10) dùng để chia nhóm tiến độ nội bộ. Kết quả `images[]` được làm phẳng theo thứ tự prompt, rồi theo thứ tự output trong prompt.

### Image-to-image batch

```bash
curl -sS -X POST http://127.0.0.1:8787/generate \
  -H 'Authorization: Bearer local-test-key' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: image-edit-UNIQUE_ID' \
  --data '{
    "worker": "extension",
    "referenceImageUrl": "http://127.0.0.1:8787/assets/ASSET_NAME.jpg",
    "ratio": "16:9",
    "outputs": 1,
    "prompts": ["Variation one", "Variation two", "Variation three"]
  }'
```

Image-to-image dùng cùng quy tắc `outputs: 1..4`; nếu không gửi field này thì mỗi prompt tạo một ảnh.

Client không gửi `projectUrl`. Backend khóa project bằng biến môi trường `FLOW_PROJECT_URL` và từ chối tạo ảnh/video nếu biến này thiếu hoặc không phải URL project Flow hợp lệ.

Sau khi POST trả `id`, client chỉ poll `GET /jobs/:id`. Không gọi lại `POST /generate` để kiểm tra tiến trình. Một ảnh mới chủ ý phải dùng một `Idempotency-Key` mới.

Ví dụ response `202 Accepted` khi chưa xong:

```json
{
  "id": "1788106456190-9ff281e5",
  "status": "queued",
  "ratio": "16:9",
  "outputs": 1,
  "total": 3,
  "createdAt": "2026-08-30T16:14:16.190Z",
  "startedAt": null,
  "finishedAt": null,
  "error": null,
  "worker": "extension",
  "progress": 0,
  "images": [],
  "logs": []
}
```

Validation errors trả `400`, ví dụ prompt rỗng, ratio sai, `outputs` ngoài 1–4, worker sai, quá số prompt, URL ảnh không phải HTTP(S), hoặc dùng ảnh tham chiếu/`outputs > 1` với Playwright.

## `POST /chat`

Chat Gemini. Endpoint này luôn dùng extension worker và response theo contract chung `200/202`.

### Request fields

| Field | Type | Bắt buộc | Mô tả |
|---|---|---:|---|
| `prompt` | string | một trong hai | Một câu lệnh |
| `prompts` | string[] | một trong hai | Batch câu lệnh chạy tuần tự |
| `model` | string | không | `3.5-flash-lite` hoặc `3.1-pro`; mặc định `3.5-flash-lite` |
| `newConversation` | boolean | không | Mặc định `true`; mở conversation mới cho prompt đầu |
| `chatUrl` | string | khi tiếp tục chat | URL thuộc `https://gemini.google.com/` |
| `timeoutMs` | number | không | Tối thiểu 30000; mặc định 300000 |
| `maxRetries` | integer | không | `0`–`5`; mặc định theo `FLOW_MAX_RETRIES` |

Nếu bỏ `model`, extension vẫn chủ động chọn Gemini 3.5 Flash Lite, không giữ model cũ trên giao diện. `model: "3.1-pro"` chọn option 3.1 Pro; sau khi chọn, nhãn thu gọn trên UI có thể chỉ hiển thị **Pro Mở rộng**.

Mỗi request logic nên có header `Idempotency-Key` duy nhất. API luôn lưu job vào Turso trước khi phản hồi. Nếu job xong trong cửa sổ chờ ngắn, API trả HTTP `200` cùng kết quả; nếu chưa xong, API trả HTTP `202` cùng `id` để client gọi `GET /jobs/:id`. Nếu kết nối đứt trước khi nhận response, gửi lại **đúng payload và cùng key**: API trả job cũ với `deduplicated: true`, không tạo hoặc chạy thêm batch. Cùng key nhưng payload khác trả HTTP `409`.

### Chat mới với model hiện tại

```bash
curl -sS -X POST http://127.0.0.1:8787/chat \
  -H 'Authorization: Bearer local-test-key' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: chat-request-UNIQUE_ID' \
  --data '{
    "model": "3.5-flash-lite",
    "newConversation": true,
    "prompt": "Trả lời đúng một dòng: CHAT_DEFAULT_OK"
  }'
```

### Chat mới với Gemini 3.1 Pro

```bash
curl -sS -X POST http://127.0.0.1:8787/chat \
  -H 'Authorization: Bearer local-test-key' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: chat-pro-UNIQUE_ID' \
  --data '{
    "model": "3.1-pro",
    "newConversation": true,
    "prompt": "Trả lời đúng một dòng: CHAT_PRO_OK"
  }'
```

### Tiếp tục một conversation

```bash
curl -sS -X POST http://127.0.0.1:8787/chat \
  -H 'Authorization: Bearer local-test-key' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: chat-followup-UNIQUE_ID' \
  --data '{
    "model": "3.5-flash-lite",
    "newConversation": false,
    "chatUrl": "https://gemini.google.com/app/CONVERSATION_ID",
    "prompt": "Tóm tắt câu trả lời trước thành ba ý"
  }'
```

Luồng tiếp tục conversation đã được triển khai nhưng chưa có smoke test riêng trong phiên test ngày 31/08/2026.

### Batch chat

```bash
curl -sS -X POST http://127.0.0.1:8787/chat \
  -H 'Authorization: Bearer local-test-key' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: chat-batch-UNIQUE_ID' \
  --data '{
    "model": "3.1-pro",
    "newConversation": true,
    "prompts": [
      "Đề xuất tên sản phẩm",
      "Chọn ba tên tốt nhất",
      "Viết slogan cho tên đầu tiên"
    ]
  }'
```

Các prompt chạy tuần tự trong cùng tab; prompt đầu mở chat mới khi `newConversation` là `true`.

Ví dụ response `202 Accepted` khi chưa xong:

```json
{
  "id": "chat-1788180000000-acde1234",
  "type": "chat",
  "status": "queued",
  "model": "3.1-pro",
  "total": 1,
  "progress": 0,
  "responses": [],
  "response": null,
  "conversationUrls": [],
  "conversationUrl": null,
  "retryAfterSeconds": 600
}
```

Response `202` còn có header `Location: /jobs/<id>` và `Retry-After: 600`. Có thể đổi thời gian gợi ý bằng `FLOW_CLIENT_POLL_AFTER_SECONDS`; mặc định là 600 giây (10 phút). Nếu hoàn tất trong thời gian chờ ngắn, POST trả `200` và dữ liệu ngay.

Khi hoàn tất, `responses[]` chứa kết quả theo thứ tự prompt và `conversationUrls[]` chứa URL thu được sau từng lượt. `response` chỉ được điền cho job có đúng một response; với batch, hãy luôn đọc `responses[]`. `conversationUrl` là URL cuối cùng.

### Contract khuyên dùng cho client batch

1. Tạo một `Idempotency-Key` cho cả batch và gọi endpoint POST tương ứng đúng một lần.
2. Nếu POST trả `200`, dùng dữ liệu ngay. Nếu trả `202`, lưu trường `id`; không cần lưu từng prompt/result.
3. Sau 10–20 phút, gọi `GET /jobs/:id`.
4. Nếu `status` là `queued` hoặc `running`, chờ theo `retryAfterSeconds` rồi GET lại; không gọi POST để kiểm tra.
5. Dừng khi `status` là `completed` hoặc `failed`. Với batch, đọc `responses[]`.
6. Chỉ khi POST ban đầu timeout trước khi nhận `id`, retry POST với cùng payload và cùng `Idempotency-Key`.

```js
const key = crypto.randomUUID();
const submitted = await fetch(`${baseUrl}/chat`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "idempotency-key": key
  },
  body: JSON.stringify({ model: "3.1-pro", prompts })
});
if (!submitted.ok) throw new Error(`POST /chat: HTTP ${submitted.status}`);
let job = await submitted.json();
if (job.status === "completed") {
  console.log(job.responses); // /generate đọc images[], /video đọc videos[]
} else {
  if (job.status === "failed") throw new Error(job.error || "Job failed");
  const { id } = job;

  // Chạy bằng scheduler/cron sau 10–20 phút.
  const polled = await fetch(`${baseUrl}/jobs/${id}`, {
    headers: { authorization: `Bearer ${apiKey}` }
  });
  if (!polled.ok) throw new Error(`GET /jobs/${id}: HTTP ${polled.status}`);
  job = await polled.json();
  if (job.status === "completed") console.log(job.responses);
}
```

## `POST /video`

Tạo video tuần tự bằng **Veo 3.1 Lite**, 720p, một video mỗi prompt. Endpoint hỗ trợ cả text-to-video và image-to-video từ một ảnh đầu, luôn dùng Chrome extension và response theo contract chung `200/202`.

```bash
curl -sS -X POST https://nhans-macbook-pro-1.tail5d608a.ts.net/video \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: video-batch-UNIQUE_ID' \
  -d '{
    "prompts": [
      "A mechanical dragon flying over Ha Long Bay at sunrise",
      "A tiny robot walking through Hoi An at night"
    ],
    "ratio": "16:9"
  }'
```

Các field: `prompt` hoặc `prompts`, `ratio` (`16:9` hoặc `9:16`), `timeoutMs` (mặc định 600 giây), `maxRetries`. Project được backend lấy từ `FLOW_PROJECT_URL`. Response `200` chứa kết quả nếu đã xong; response `202` trả `id` để client poll `GET /jobs/:jobId`. Khi xong, public S3 URL nằm trong `videos[]` theo thứ tự prompt.

Image-to-video dùng thêm `referenceImageUrl`. URL có thể là public HTTP(S), hoặc URL từ `POST /assets`:

```bash
curl -sS -X POST https://nhans-macbook-pro-1.tail5d608a.ts.net/video \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: image-video-UNIQUE_ID' \
  -d '{
    "prompt": "The robotic peacock slowly spreads its glowing tail, smooth camera push in",
    "referenceImageUrl": "https://example.com/reference.jpg",
    "ratio": "16:9"
  }'
```

Một `referenceImageUrl` được dùng lại cho mọi prompt trong batch. Ảnh là khung hình đầu; ảnh cuối không bắt buộc và API hiện không nhận ảnh cuối.

Mỗi prompt luôn tạo đúng một video (`x1`). Extension dùng một tab Flow riêng cho video, bấm **Video** ở sidebar rồi xác nhận composer đang ở chế độ **Video**. Vì sidebar chỉ lọc thư viện chứ không đổi composer, extension sẽ chọn **Video** trong popup nếu tab mới hoặc vừa bị reset. Text-to-video chọn **Thành phần**; image-to-video chọn **Khung hình**, upload ảnh làm khung hình đầu. Sau đó extension cấu hình tỷ lệ → Veo 3.1 Lite → x1, nhập prompt bằng sự kiện bàn phím thật, mở thẻ video mới, tải MP4 và upload lên S3. Client có thể gửi nhiều prompt trong một job; worker xử lý tuần tự để tránh tốn tín dụng ngoài ý muốn.

Ví dụ kết quả video hoàn tất:

```json
{
  "id": "video-job-id",
  "status": "completed",
  "model": "veo-3.1-lite",
  "progress": 1,
  "total": 1,
  "images": [],
  "videos": [
    "https://s3a.schoolsai.work/flow-images/jobs/video-job-id/001-01-1788190000000.mp4"
  ],
  "error": null
}
```

## `POST /video/extend`

Nối thêm một đoạn vào scene Flow bằng **Kéo dài (Veo 3.1 Lite)**. Flow tự dùng cảnh cuối của video nguồn làm cảnh đầu của đoạn mới.

```bash
curl -sS -X POST https://nhans-macbook-pro-1.tail5d608a.ts.net/video/extend \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: video-extend-UNIQUE_ID' \
  -d '{
    "sourceFlowUrl": "https://labs.google/fx/vi/tools/flow/project/PROJECT_ID/scene/SCENE_ID",
    "prompt": "The camera follows the character through the doorway into a moonlit garden"
  }'
```

`sourceFlowUrl` bắt buộc là URL scene Google Flow có dạng `/project/.../scene/...`; URL MP4/S3 không dùng được cho luồng native này. `prompt` là bắt buộc. `timeoutMs` mặc định 900.000 ms. `maxRetries` mặc định `0` vì retry sau khi Flow đã nhận thao tác có thể nối trùng clip.

Kết quả hoàn tất:

```json
{
  "id": "video-extend-job-id",
  "type": "video",
  "mode": "extend",
  "status": "completed",
  "videos": ["https://s3a.schoolsai.work/flow-images/jobs/video-extend-job-id/001.mp4"],
  "flowUrl": "https://labs.google/fx/vi/tools/flow/project/PROJECT_ID/scene/SCENE_ID",
  "durationSeconds": 16
}
```

Để nối nhiều đoạn, chờ job hiện tại `completed`, rồi gửi request mới với `sourceFlowUrl` bằng `flowUrl` vừa trả về. Không gửi song song hai lệnh nối cho cùng một scene.

## `GET /jobs/:jobId`

```bash
curl -sS \
  -H 'Authorization: Bearer local-test-key' \
  http://127.0.0.1:8787/jobs/JOB_ID
```

Response khi extension hoàn tất:

```json
{
  "id": "1788106456190-9ff281e5",
  "status": "completed",
  "ratio": "16:9",
  "outputs": 1,
  "total": 3,
  "startedAt": "2026-08-30T16:14:17.225Z",
  "finishedAt": "2026-08-30T16:17:50.628Z",
  "error": null,
  "worker": "extension",
  "progress": 3,
  "images": [
    "https://s3a.schoolsai.work/flow-images/jobs/1788106456190-9ff281e5/001-01-1788106500000.png",
    "https://s3a.schoolsai.work/flow-images/jobs/1788106456190-9ff281e5/002-01-1788106600000.png",
    "https://s3a.schoolsai.work/flow-images/jobs/1788106456190-9ff281e5/003-01-1788106700000.png"
  ],
  "logs": [
    "chrome-worker nhận prompt 1/3",
    "Prompt 1 hoàn tất",
    "chrome-worker nhận prompt 2/3",
    "Prompt 2 hoàn tất",
    "chrome-worker nhận prompt 3/3",
    "Prompt 3 hoàn tất"
  ]
}
```

Chú ý: `progress` đếm prompt đã có result, không đếm từng ảnh. Luôn kiểm tra cả `status` và `error`. Khi job `completed`, `images` chứa public S3 URL theo thứ tự prompt rồi output; số URL kỳ vọng là `total * outputs`.

Chống tạo trùng: POST `/generate`, `/chat` hoặc `/video` đúng một lần. Nếu nhận `200`, dùng kết quả ngay; nếu nhận `202`, lưu `id` rồi chỉ poll bằng GET. Nếu chưa chắc POST đầu tiên đã tới server, retry cùng `Idempotency-Key`; tuyệt đối không sinh key mới cho cùng một yêu cầu logic.

Với job chat, cùng endpoint trả thêm `model`, `responses`, `response`, `conversationUrls` và `conversationUrl`; `images` sẽ rỗng. Với job video, `model` là `veo-3.1-lite`, `images` rỗng và kết quả nằm trong `videos`.

### Poll đến khi xong bằng shell

Yêu cầu `jq`:

```bash
JOB_ID='replace-me'

while true; do
  BODY=$(curl -sS \
    -H 'Authorization: Bearer local-test-key' \
    "http://127.0.0.1:8787/jobs/$JOB_ID")
  printf '%s\n' "$BODY" | jq '{status,progress,total,error,logs}'
  STATUS=$(printf '%s' "$BODY" | jq -r '.status')
  case "$STATUS" in
    completed) exit 0 ;;
    failed) exit 1 ;;
  esac
  sleep 5
done
```

## Endpoint nội bộ của extension

`POST /extension/claim`, `POST /extension/media` và `POST /extension/result` là protocol giữa Chrome extension và server. Client ứng dụng không nên gọi trực tiếp. `/extension/media` nhận ảnh hoặc video, upload S3 rồi trả public URL và `objectKey`. `/extension/image` vẫn được giữ để tương thích bản cũ.

- Worker poll khoảng mỗi 6 giây.
- Mỗi claim giữ một lease ít nhất 5 phút hoặc bằng `timeoutMs`.
- Nếu extension chết sau khi claim, task chỉ có thể được claim lại sau khi lease hết.
- Server không có endpoint cancel/retry ở phiên bản hiện tại.

## Error model

Lỗi có dạng:

```json
{
  "error": "Mô tả lỗi"
}
```

| HTTP | Ý nghĩa thường gặp |
|---:|---|
| `400` | Request không hợp lệ |
| `401` | Thiếu hoặc sai API key |
| `404` | Job/asset/ảnh không tồn tại |
| `409` | `Idempotency-Key` dùng lại với payload khác, hoặc extension trả result cho lease đã hết/sai task |
| `415` | MIME ảnh không hỗ trợ |
| `500` | JSON lỗi, file quá lớn, I/O hoặc lỗi server khác |
