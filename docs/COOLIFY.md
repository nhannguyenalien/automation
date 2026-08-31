# Deploy backend và Chromium worker trên Coolify

Stack dùng hai service trong `docker-compose.coolify.yml`:

- `backend`: Node.js API, port nội bộ `8787`.
- `chrome`: Chromium chạy có giao diện qua Xvfb; noVNC ở port nội bộ `6080`; extension được nạp tự động; profile đăng nhập nằm trong volume `chrome-profile`.

## 1. Tạo resource

Trong Coolify, tạo **Docker Compose** resource từ Git repository và chọn file:

```text
docker-compose.coolify.yml
```

Không đưa file `.env` thật lên Git. Khai báo secrets trong phần Environment Variables của Coolify.

## 2. Biến môi trường bắt buộc

```dotenv
FLOW_API_KEY=<random-secret-dai>
FLOW_PROJECT_URL=https://labs.google/fx/vi/tools/flow/project/PROJECT_ID
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
S3_ENDPOINT=https://...
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_PUBLIC_URL=https://.../flow-images
NOVNC_PASSWORD=<mat-khau-noVNC-manh>
```

Các biến có giá trị mặc định được liệt kê trong `.env.example`.

## 3. Gắn domain

- Gắn domain API vào service `backend`, port `8787`.
- Gắn một domain riêng vào service `chrome`, port `6080`, và không chia sẻ công khai.
- Bật HTTPS cho cả hai domain. `NOVNC_PASSWORD` bảo vệ phiên VNC; nên giới hạn thêm bằng VPN, firewall hoặc access control của reverse proxy.

Extension gọi backend qua Docker network tại `http://backend:8787`; API public domain chỉ dành cho client bên ngoài.

## 4. Đăng nhập Google lần đầu

1. Deploy stack và chờ cả hai service healthy.
2. Mở domain noVNC của service `chrome` và nhập `NOVNC_PASSWORD`.
3. Đăng nhập tài khoản Google trong Chromium.
4. Mở `FLOW_PROJECT_URL` ít nhất một lần và xác nhận Flow hoạt động.
5. Mở `https://gemini.google.com/app` và xác nhận Gemini hoạt động.

Profile và cookie được giữ trong volume `chrome-profile`, nên redeploy image không làm mất phiên đăng nhập. Không xóa volume này nếu muốn giữ session.

## 5. Kiểm tra

```bash
curl https://API_DOMAIN/health
```

Sau đó gửi một job nhỏ. Extension đã được container cấu hình tự động bằng `FLOW_API_KEY`, worker ID và URL backend nội bộ; không cần nhập lại trong popup.

## Lưu ý vận hành

- Chromium được dùng thay vì Firefox vì extension dùng Manifest V3 và API `chrome.*`.
- Container cần khoảng 2 GB shared memory và nên có tối thiểu 2 CPU / 4 GB RAM cho một worker.
- Google có thể yêu cầu đăng nhập lại hoặc CAPTCHA; xử lý qua noVNC.
- Đổi `FLOW_API_KEY` hoặc cấu hình extension rồi redeploy sẽ cập nhật storage vì `FLOW_EXTENSION_FORCE_CONFIG=true`.
- Không scale service `chrome` nếu chưa đặt worker ID riêng cho từng replica.
