import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import main


class FakeResponse:
    status_code = 200
    is_error = False

    @staticmethod
    def json():
        return {"choices": [{"message": {"content": "Здравствуйте! Чем помочь?"}}]}


class FakeAsyncClient:
    last_request = None

    def __init__(self, **kwargs):
        self.timeout = kwargs["timeout"]

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, url, headers, json):
        FakeAsyncClient.last_request = {"url": url, "headers": headers, "json": json}
        return FakeResponse()


class ChatApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        FakeAsyncClient.last_request = None
        main.requests_by_ip.clear()

    def test_health_check(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})

    def test_forwards_chat_using_server_key(self):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "server-only-test-key"}):
            with patch.object(main.httpx, "AsyncClient", FakeAsyncClient):
                response = self.client.post(
                    "/api/chat",
                    json={"messages": [{"role": "user", "content": "Привет"}]},
                    headers={"Origin": "https://vnmhimvm.github.io"},
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"reply": "Здравствуйте! Чем помочь?"})
        self.assertEqual(
            FakeAsyncClient.last_request["headers"]["Authorization"],
            "Bearer server-only-test-key",
        )
        self.assertEqual(
            FakeAsyncClient.last_request["json"]["messages"],
            [{"role": "user", "content": "Привет"}],
        )

    def test_missing_provider_key_is_a_clear_service_error(self):
        with patch.dict(os.environ, {}, clear=True):
            response = self.client.post(
                "/api/chat",
                json={"messages": [{"role": "user", "content": "Привет"}]},
            )
        self.assertEqual(response.status_code, 503)
        self.assertIn("не настроен", response.json()["detail"])

    def test_rejects_non_user_final_message(self):
        response = self.client.post(
            "/api/chat",
            json={"messages": [{"role": "assistant", "content": "Hello"}]},
        )
        self.assertEqual(response.status_code, 400)

    def test_rejects_oversized_body(self):
        response = self.client.post(
            "/api/chat",
            content=b"x" * (main.MAX_BODY_BYTES + 1),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(response.status_code, 413)

    def test_rate_limits_repeated_requests_from_one_ip(self):
        with patch.dict(os.environ, {}, clear=True):
            responses = [
                self.client.post(
                    "/api/chat",
                    json={"messages": [{"role": "user", "content": "Привет"}]},
                )
                for _ in range(main.MAX_REQUESTS_PER_MINUTE)
            ]
            limited = self.client.post(
                "/api/chat",
                json={"messages": [{"role": "user", "content": "Привет"}]},
            )
        self.assertTrue(all(response.status_code == 503 for response in responses))
        self.assertEqual(limited.status_code, 429)
        self.assertGreaterEqual(int(limited.headers["retry-after"]), 1)
        self.assertLessEqual(int(limited.headers["retry-after"]), 60)

    def test_cors_is_limited_to_configured_origin(self):
        allowed = self.client.options(
            "/api/chat",
            headers={
                "Origin": "https://vnmhimvm.github.io",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        blocked = self.client.options(
            "/api/chat",
            headers={
                "Origin": "https://not-your-site.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        self.assertEqual(allowed.headers.get("access-control-allow-origin"), "https://vnmhimvm.github.io")
        self.assertNotIn("access-control-allow-origin", blocked.headers)
        health = self.client.get(
            "/health",
            headers={"Origin": "https://vnmhimvm.github.io"},
        )
        self.assertEqual(health.headers.get("access-control-expose-headers"), "Retry-After")


if __name__ == "__main__":
    unittest.main()
