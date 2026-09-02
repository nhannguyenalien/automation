# Runbook vận hành

## Khởi động

### API

```bash
cd /Users/nhannguyen/Documents/ChatGPT/imageai
FLOW_API_KEY='your-secret' \
FLOW_WORKER='extension' \
FLOW_PROJECT_URL='https://labs.google/fx/vi/tools/flow/project/PROJECT_ID' \
S3_ENDPOINT='https://s3a.schoolsai.work' \
S3_REGION='us-east-1' \
S3_BUCKET='flow-images' \
S3_ACCESS_KEY='service-account-access-key' \
S3_SECRET_KEY='service-account-secret-key' \
S3_PUBLIC_URL='https://s3a.schoolsai.work/flow-images' \
S3_MANAGE_BUCKET='false' \
npm run api
```

### Chạy bền trên máy Mac bằng LaunchAgent

Máy test đã có mẫu `ops/com.schoolsai.flow-api.plist`. Cài một lần để API tự
khởi động khi đăng nhập và tự chạy lại nếu tiến trình Node bị dừng:

```bash
mkdir -p logs
cp ops/com.schoolsai.flow-api.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.schoolsai.flow-api.plist
```

Kiểm tra bằng `curl http://127.0.0.1:8787/health`. Log nằm trong
`logs/flow-api.log` và `logs/flow-api.error.log`. Khi LaunchAgent đang chạy thì
không mở thêm `node flow_api.mjs`, nếu không sẽ gặp `EADDRINUSE`.

Không đóng terminal này khi test local.

### Chrome worker

1. Mở Chrome bằng profile đã đăng nhập Google Pro.
2. Kiểm tra extension đang Enabled tại `chrome://extensions`.
3. Mở popup extension và kiểm tra API URL/key.
4. Bật worker và bấm lưu.
5. Giữ hai tab Flow cùng project và một tab `https://gemini.google.com/app` mở.
6. Xác nhận cả Flow và Gemini đều đã đăng nhập trong cùng Chrome profile. Extension gán riêng tab **Flow Image** và **Flow Video**, bấm mục tương ứng ở sidebar, rồi kiểm tra loại trình tạo trong popup cấu hình. Sidebar chỉ lọc thư viện; với tab mới hoặc vừa bị reset, extension sẽ chọn **Hình ảnh**/**Video** trong popup đúng một lần và giữ nguyên cho các job sau.

## Smoke test sau khi khởi động

### 1. Health

```bash
curl -sS http://127.0.0.1:8787/health
```

### 2. Một prompt rẻ/ngắn

```bash
curl -sS -X POST http://127.0.0.1:8787/generate \
  -H 'Authorization: Bearer your-secret' \
  -H 'Content-Type: application/json' \
  --data '{
    "worker":"extension",
    "projectUrl":"https://labs.google/fx/vi/tools/flow/project/PROJECT_ID",
    "ratio":"1:1",
    "outputs":1,
    "prompt":"A simple red apple on a white background"
  }'
```

### 3. Quan sát

- trong khoảng 6 giây, extension phải claim prompt;
- tab Flow được focus và prompt xuất hiện;
- nút Generate được bấm;
- job chuyển `queued` → `running` → `completed`;
- `images` trong job chứa public S3 URL và URL mở được không cần credential;
- file backup mới xuất hiện trong `~/Downloads/flow-images`.

Để smoke test nhiều ảnh cho một prompt, đổi thành `"outputs":3`. Khi hoàn tất, `progress` vẫn là `1` nhưng `images` phải có đúng 3 URL S3.

### 4. Gemini Chat mặc định

```bash
curl -sS -X POST http://127.0.0.1:8787/chat \
  -H 'Authorization: Bearer your-secret' \
  -H 'Content-Type: application/json' \
  --data '{
    "model":"3.5-flash-lite",
    "newConversation":true,
    "prompt":"Trả lời đúng một dòng: CHAT_DEFAULT_OK"
  }'
```

Poll ID trả về. Kết quả đạt khi job `completed`, `responses[0]` chứa chuỗi yêu cầu và `conversationUrl` thuộc `https://gemini.google.com/`.

### 5. Gemini 3.1 Pro

```bash
curl -sS -X POST http://127.0.0.1:8787/chat \
  -H 'Authorization: Bearer your-secret' \
  -H 'Content-Type: application/json' \
  --data '{
    "model":"3.1-pro",
    "newConversation":true,
    "prompt":"Trả lời đúng một dòng: CHAT_PRO_OK"
  }'
```

Sau khi extension chọn 3.1 Pro, picker thu gọn có thể hiện **Pro Mở rộng**; đây là trạng thái hợp lệ. Kiểm tra response và conversation URL giống bước trên.

## Reload đúng cách sau khi sửa extension

1. Mở `chrome://extensions`.
2. Bấm **Reload** trên Google AI Browser Worker.
3. Không cần reload Flow/Gemini thủ công trong đa số trường hợp: worker sẽ thử ping và tự reload tab nếu content script chưa sẵn sàng.
   Sau khi source extension đã sửa xong, chỉ bấm Reload extension một lần; không reload tab Flow liên tục trong lúc job đang tạo.
4. Nếu muốn kiểm tra ngay trên tab đang mở, refresh tab Flow/Gemini một lần sau khi reload extension.
5. Nếu job đã claim trước khi reload extension, đợi lease hết hoặc restart API và gửi job mới trong môi trường test.

## Theo dõi job

```bash
curl -sS \
  -H 'Authorization: Bearer your-secret' \
  http://127.0.0.1:8787/jobs/JOB_ID
```

Diễn giải:

- `queued`, progress 0: chưa có extension claim;
- `running`: extension đã nhận ít nhất một prompt;
- `completed`: mọi prompt đã báo thành công;
- `failed`: xem `error` và dòng cuối `logs`;
- `images: []` khi completed: bất thường; kiểm tra S3 và extension log.

### S3 không khởi động được

- kiểm tra `S3_ENDPOINT` có `https://` và không có path bucket;
- khi `S3_MANAGE_BUCKET=true`, credential cần `HeadBucket`, `CreateBucket`, `PutBucketPolicy`, `PutObject`;
- khi bucket đã bootstrap, để `S3_MANAGE_BUCKET=false`; service account chỉ cần `PutObject` cho prefix output;
- dùng service account riêng sau lần bootstrap, không dùng root credential lâu dài;
- `curl -I <public-url>` phải đọc được object mà không gửi authorization;
- nếu dùng CDN/custom domain khác endpoint, đặt chính xác `S3_PUBLIC_URL`.

## Xử lý lỗi

### Job đứng ở `queued`

Kiểm tra theo thứ tự:

1. API còn chạy không: `GET /health`.
2. Extension đã bật worker chưa.
3. API URL/key trong popup có đúng không.
4. Extension có được reload sau lần sửa source không.
5. Mở `chrome://extensions`, chọn **service worker / Inspect views** để xem console error.

### Job `running` nhưng tab đứng im

- Đảm bảo tab đang ở trang project gallery, không phải `/edit/<media-id>`.
- Đợi tối đa `timeoutMs`; việc tạo ảnh thường mất hơn một phút.
- Kiểm tra quota/credits và thông báo lỗi trong Flow.
- Kiểm tra Flow có đổi ngôn ngữ/UI hoặc nút không còn tên mà selector nhận biết.
- Mở DevTools console của tab Flow để xem content-script error.

Với chat, kiểm tra thêm tab đang ở `gemini.google.com`, không có dialog che prompt, response trước đã dừng và tài khoản còn quyền dùng model đã chọn.

### Gemini có prompt nhưng chưa gửi

- kiểm tra nút gửi đã xuất hiện và không bị disabled;
- content script phải chọn editor hiển thị, không chọn `.ql-clipboard` ẩn;
- reload extension rồi để worker tự reload tab Gemini;
- xem console của tab Gemini và service worker để phát hiện selector UI đã đổi.

### Không chọn được model Gemini

- mở picker thủ công và xác nhận account có option **3.1 Pro**;
- nhãn sau khi chọn có thể là **Pro Mở rộng**, không nhất thiết giữ nguyên chữ “3.1 Pro”;
- nếu option đã đổi tên/ngôn ngữ, cập nhật mapping trong `flow-extension/gemini.js` rồi reload extension;
- nếu bỏ `model`, API và extension vẫn chủ động chọn **3.5 Flash Lite**, không giữ model cũ trên UI.

### Chat timeout hoặc lấy thiếu response

- tăng `timeoutMs` nếu Gemini đang suy luận lâu;
- không gửi thao tác thủ công vào cùng tab khi worker đang chạy;
- đợi nút dừng biến mất và response ổn định; giao diện tiếng Việt hiện có thể ghi
  **Ngừng tạo câu trả lời**, không chỉ **Dừng phản hồi**;
- nếu API trả kết quả khi nút này vẫn còn hiện, reload bản extension mới nhất rồi
  refresh tab Gemini trước khi gửi lại bằng một `Idempotency-Key` mới;
- kiểm tra quota, policy warning và lỗi mạng trên giao diện Gemini.

### Prompt có chữ nhưng nút Generate không bật

Flow dùng editor stateful; gán `textContent` không đủ. Code hiện gửi keyboard event thật qua CDP. Nếu lỗi quay lại:

- đảm bảo permission `debugger` còn trong manifest;
- không mở DevTools debugger khác đang attach cùng tab;
- click thủ công vào editor một lần để xác nhận Flow vẫn hoạt động;
- kiểm tra selector editor `[contenteditable="true"]`.

### Báo “Bạn phải cung cấp câu lệnh”

UI vẽ được chữ nhưng internal editor state chưa nhận input, hoặc content script chọn nhầm editor. Reload extension + tab rồi test lại. Nếu tái diễn, kiểm tra `inputLikeUser`, `TYPE_TEXT` và cách chọn editor thấp nhất trên trang trong `flow.js`.

### Popup chọn file macOS vẫn hiện

Đây là giới hạn đã quan sát với Chrome/macOS. Worker vẫn có thể gán file bằng CDP và tiếp tục chạy; popup không đồng nghĩa upload thất bại.

Không tự động bấm trong popup khi job còn đang xử lý. Sau khi batch kết thúc, có thể đóng bằng Cancel/Escape thủ công. Muốn chạy unattended ổn định hơn, ưu tiên Linux desktop/VM hoặc thiết kế lại worker bằng Playwright `filechooser.setFiles` sau khi image-to-image được port đầy đủ.

### Đứng ở media picker hoặc “Thêm vào câu lệnh”

- kiểm tra ảnh có xuất hiện trong thư viện Flow;
- kiểm tra file tạm trong `~/Downloads/flow-images/references`;
- URL ảnh phải trả `Content-Type: image/*`;
- thử upload qua `POST /assets` để dùng same-origin thay vì URL bên ngoài;
- UI tiếng Việt/Anh đều được selector hiện tại hỗ trợ, ngôn ngữ khác có thể không.

### `401 Unauthorized`

API và extension/client đang dùng khác key. Whitespace cũng được tính là một phần của key. Lưu lại popup sau khi sửa.

### `409 Task không còn lease`

Extension trả kết quả quá muộn, gửi trùng, hoặc API/job đã đổi state. Không có retry endpoint; trong bản hiện tại hãy gửi job mới.

### Video nối xuất hiện rồi mất sau reload

Đừng coi timeline 16 giây vừa xuất hiện ngay sau khi bấm **Tạo** là hoàn tất. Chỉ dùng kết quả khi job API đã `completed`, có `flowUrl`, `videos[]` và `durationSeconds` đã tăng. Worker đợi UI render thật trước khi trả kết quả. Khi nối đoạn tiếp theo, dùng chính `flowUrl` trả về; không dùng public URL MP4/S3. Không gửi đồng thời hai job `/video/extend` cho cùng một scene.

### `404 Không tìm thấy job`

Job ID sai hoặc API đã restart. Job extension chỉ nằm trong RAM.

### File output không thấy

1. Mở `chrome://downloads` và xem download bị interrupted không.
2. Kiểm tra Chrome Settings → Downloads.
3. Tắt tùy chọn hỏi vị trí lưu từng file; extension dùng `saveAs: false` nhưng policy/profile vẫn có thể tác động.
4. Tìm trong `~/Downloads/flow-images`.

### Job completed nhưng ảnh sai prompt hoặc có watermark Veo

Đây là lỗi tương quan kết quả, không phải lỗi queue/job ID. Worker hiện áp dụng cơ chế fail-safe:

- chờ thư viện ảnh ổn định trước khi bấm Tạo;
- chuẩn hóa chữ hoa/thường và khoảng trắng, sau đó so khớp toàn bộ prompt khách gửi với text trong chính card kết quả;
- chỉ nhận card có cả URL card và nguồn thumbnail mới xuất hiện sau lúc submit;
- loại card/video thumbnail có dấu hiệu Veo, Video hoặc Play;
- card trong thư viện không có prompt nên extension không so khớp tại gallery; nó thu asset ID mới, mở từng card và so prompt đầy đủ ngay trong viewer;
- chỉ tải ảnh lớn khi prompt viewer khớp chính xác prompt job; card cũ/sai prompt (kể cả Veo) bị bỏ qua, hết candidate mới fail thay vì trả ảnh sai nhưng báo `completed`.

Sau khi cập nhật `flow-extension/flow.js`, mở `chrome://extensions`, bấm **Reload** cho extension và reload tab Flow. Chạy đúng một image smoke test với prompt dễ nhận biết trước. Chỉ chạy batch khi URL trả về đúng prompt và không có watermark Veo. Console tab Flow sẽ có log `selected correlated image result` kèm `jobId`, `index`, `output`, tổng candidate và số viewer bị loại vì sai prompt; log không chứa URL ảnh hoặc prompt.

Nếu lỗi selector/tương quan này xảy ra trong một batch, extension tự mở circuit breaker và dừng toàn bộ lane ảnh. Prompt lỗi được trả về queue theo chính sách retry, còn các prompt sau không bị chạy rồi lỗi hàng loạt. Sau khi sửa/reload tab Flow, mở popup extension và bấm **Lưu & chạy** để xóa circuit breaker rồi tiếp tục queue.

### Ảnh tham chiếu URL ngoài không tải được

Extension hiện chỉ có host permissions cho localhost/127.0.0.1 và Google Flow. Cách chắc chắn hiện tại là upload ảnh vào `POST /assets`, sau đó dùng URL asset trả về. Khi triển khai remote phải cập nhật `host_permissions` theo domain API HTTPS.

## Dừng và khởi động lại

### Dừng API

Nhấn `Ctrl+C` tại terminal API. Việc này làm mất queue và job status trong RAM, nhưng không xóa asset/output trên disk.

### Khởi động lại an toàn

1. Không restart khi Flow đang tạo ảnh nếu có thể.
2. Dừng nhận job mới ở phía client.
3. Đợi job hiện tại hoàn tất.
4. Dừng API, chạy lại với cùng config.
5. Gửi smoke test mới; job ID cũ không còn truy cập được.

## Cleanup

Không có cleanup tự động. Trước khi xóa, dừng API và xác nhận chính xác thư mục.

Các vị trí có thể tăng dung lượng:

```text
/Users/nhannguyen/Documents/ChatGPT/imageai/.flow-api/assets
/Users/nhannguyen/Documents/ChatGPT/imageai/.flow-api/jobs
~/Downloads/flow-images
```

Không xóa Chrome profile nếu chưa backup/đăng nhập lại được. Chrome profile chứa session nhạy cảm.

## Checklist trước khi giao cho máy khác

- Node/npm đúng phiên bản và `npm install` thành công.
- Chrome đã đăng nhập tài khoản được phép dùng Flow.
- Gemini đã đăng nhập và chat thủ công được trong cùng profile.
- Extension load unpacked thành công.
- API key mới, không phải key từng lộ trong chat/source.
- `projectUrl` trỏ tới project tồn tại.
- Worker enabled và có Worker ID riêng.
- Chrome không hỏi nơi lưu file mỗi lần.
- Text-to-image smoke test pass.
- Upload asset + image-to-image smoke test pass.
- Batch 3 prompt pass.
- Gemini Chat `default` smoke test pass.
- Gemini Chat `3.1-pro` smoke test pass.
- Có giám sát dung lượng Downloads và asset store.
- Người vận hành biết job state mất khi API restart.

## Khuyến nghị triển khai hiện tại

Cho giai đoạn test: giữ API và Chrome extension trên cùng một máy, API bind `127.0.0.1`. Đây là cấu hình đơn giản nhất và phù hợp permissions hiện tại.

Cho production sau này: dùng một VM Linux riêng có Chrome UI/persistent profile, API/queue bền vững và object storage. Giữ ba tab cố định: Gemini Chat, Flow Image và Flow Video. Extension tự gán tab theo lane và chỉ xử lý một task trên mỗi tab tại một thời điểm; ảnh và video có thể chạy song song vì không dùng chung tab Flow. Không chỉ đặt Chrome trong container stateless; session, Downloads, display và browser profile cần volume/persistence rõ ràng. Tạo bucket/policy bằng admin một lần, sau đó chạy API bằng service account chỉ có quyền ghi/đọc cần thiết trên bucket đó.
