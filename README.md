# Paseo 플러그인 모음

Paseo에서 사용할 수 있는 플러그인 세 가지를 `plugins/` 아래에 모았습니다. 각 플러그인은 독립 프로젝트이며 자기 폴더 안의 `paseo-plugin.json`을 기준으로 설치됩니다.

| 플러그인 | 버전 | 기능 | Paseo 호환성 |
| --- | ---: | --- | --- |
| [계정 관리자](plugins/multi-harness-accounts/README.md) · `multi-harness-accounts` | 1.5.10 | Codex·Claude Code 계정, 사용량, 예약 메시지와 확장 관리 | `>=0.10.0`; 예약 전송은 호스트 안전 확장 필요 |
| [홈 파일](plugins/home-finder/README.md) · `home-finder` | 1.3.1 | 파일 탐색, 미리보기, 이름 변경, 즐겨찾기와 브라우저 다운로드 | `>=0.10.0 <0.12.0` |
| [시스템 관리](plugins/system-care/README.md) · `system-care` | 1.0.2 | Ubuntu 용량·리소스 진단, Docker 관리와 승인형 정리 | `>=0.10.0 <0.12.0` |

## GitHub에서 설치

Paseo CLI가 설치된 daemon 호스트에서 원하는 플러그인 명령을 실행하세요. 아래 명령은 GitHub 저장소의 플러그인 하위 폴더를 직접 설치합니다.

```sh
paseo plugin install 'github:louis1618/paseo-plugins:plugins/multi-harness-accounts'
paseo plugin install 'github:louis1618/paseo-plugins:plugins/home-finder'
paseo plugin install 'github:louis1618/paseo-plugins:plugins/system-care'
paseo plugin ls
```

이미 설치된 플러그인 ID는 중복 설치하지 마세요. 설치 상태 확인과 갱신은 다음처럼 합니다.

```sh
paseo plugin ls
paseo plugin update multi-harness-accounts
paseo plugin update home-finder
paseo plugin update system-care
```

## 로컬 폴더에서 설치

GitHub 경로 대신 daemon 호스트에 저장소를 clone해 설치할 수도 있습니다.

```sh
git clone https://github.com/louis1618/paseo-plugins.git
cd paseo-plugins
paseo plugin install "$(pwd)/plugins/multi-harness-accounts"
paseo plugin install "$(pwd)/plugins/home-finder"
paseo plugin install "$(pwd)/plugins/system-care"
paseo plugin ls
```

Paseo 앱의 **Settings → Plugins**에서 각 플러그인 폴더의 절대 경로를 소스로 입력해 설치하는 방법도 있습니다. GitHub 하위 경로 설치 문법은 [Paseo 플러그인 문서](https://paseo.sh/docs/plugins/reference#plugin-sources)를 참고하세요.

## 플러그인별 추가 준비

- **계정 관리자:** `codex`, `claude`, `paseo` CLI가 daemon 호스트의 `PATH`에 있어야 합니다. 예약 전송은 호스트의 안전 확장을 요구합니다. 버전 숫자를 고정하지 않고 호스트 구조를 검사하며, 적용과 재시작 방법은 [플러그인 안내](plugins/multi-harness-accounts/README.md)를 따르세요.
- **홈 파일:** daemon 호스트의 홈 디렉터리를 탐색합니다. 다른 기기에서 다운로드하려면 해당 기기의 브라우저가 호스트 파일 URL에 직접 접속할 수 있어야 합니다. VPN/네트워크 조건과 지원 형식은 [플러그인 안내](plugins/home-finder/README.md)를 참고하세요.
- **시스템 관리:** Ubuntu 24.04 이상과 로컬 Docker 접근이 필요합니다. 기본 진단과 Docker 기능은 관리자 도우미 없이 사용할 수 있습니다. APT 캐시·보관 로그 정리를 켜려면 [플러그인 안내](plugins/system-care/README.md)에 있는 관리자 승인 절차를 별도로 진행하세요.

## 호스트와 신뢰

플러그인은 설치한 Paseo daemon의 권한과 파일 시스템을 사용합니다. 서버 코드와 설치 준비 명령은 daemon 호스트에서 실행되므로, 설치 전에 각 플러그인의 README와 보안·권한 설명을 확인하세요. 자세한 동작은 [Paseo 플러그인 시작 안내](https://paseo.sh/docs/plugins)와 [플러그인 소스 문서](https://paseo.sh/docs/plugins/reference#plugin-sources)를 참고하세요.
