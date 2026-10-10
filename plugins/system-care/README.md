# Paseo 시스템 관리

Ubuntu 호스트의 디스크·CPU·메모리·Docker를 함께 보는 한국어 Paseo 플러그인입니다. 분석만 자동으로 수행하며, 정리·종료는 선택 → 미리보기 → 확인 후 실행합니다.

## 설치

Ubuntu 24.04+, Node 22+, Paseo 0.10.x 또는 0.11.x와 로컬 Docker 권한을 사용합니다. 1.0.2부터 개발 SDK·클라이언트·프로토콜을 0.11.1로 맞췄으며 기존 사이드바 API를 유지합니다.

GitHub에서 바로 설치:

```sh
paseo plugin install 'github:louis1618/paseo-plugins:plugins/system-care'
paseo plugin ls
```

로컬 폴더에서 설치하려면 저장소를 clone한 뒤 실행합니다.

```sh
git clone https://github.com/louis1618/paseo-plugins.git
cd paseo-plugins
paseo plugin install "$(pwd)/plugins/system-care"
```

사이드바 **시스템 관리**를 엽니다. 화면은 요약 / 정리 / 리소스 / Docker로 구성되며 설정·작업 이력·승인·로그는 호스트 모달을 사용합니다. 모바일에서도 같은 호스트를 조회합니다. 설정의 보호 목록은 이름·ID를 정확히 입력하며 Compose 경로는 호스트의 절대 경로입니다.

상단 **자동 정리**는 최신 상태에서 정리할 수 있는 오래된 캐시·미사용 Docker 항목을 모아 변경 내용 확인 화면을 엽니다. **확인 후 실행**을 누르면 한 번에 처리하며, 실행 중인 프로그램의 정상 종료는 리소스 탭에서 직접 선택합니다. 보호·참조 미확인 항목과 컨테이너·볼륨 삭제는 자동 정리에 포함하지 않습니다. 관리자 도우미가 없는 시스템 캐시는 제외 사유를 표시합니다.

## 관리자 도우미

도우미 없이도 진단, 사용자 썸네일 캐시와 Docker 관리는 사용할 수 있습니다. APT 캐시·보관 로그 정리는 root 소유의 고정 도우미와 매번 관리자 인증을 사용합니다.

설정의 **Ubuntu에서 관리자 도우미 설치 승인**을 누르고 Ubuntu 호스트의 인증 창에서 승인합니다. 데몬 세션에서 인증 창이 열리지 않으면 호스트 터미널에서 아래 명령을 실행합니다. 코드 검토 후 최초 한 번 설치하며 비밀번호를 Paseo에 입력하거나 저장하지 않습니다.

```sh
cd paseo-plugins/plugins/system-care
pkexec /usr/bin/python3 -I "$(pwd)/helpers/install.py"
```

설치하는 파일은 `/usr/local/libexec/paseo-system-care-helper`와 `/usr/share/polkit-1/actions/org.paseo.system-care.policy` 두 개입니다. helper는 `apt-autoclean`, `journal-vacuum` 두 동작만 받고 사용자 경로나 명령을 실행하지 않습니다. 승인 취소·부재 시 정리를 수행하지 않습니다. `apt-get autoclean`은 설치된 패키지를 삭제하지 않습니다. journal은 30일 이상 지난 보관 로그만 정리하며 활성 로그의 강제 회전을 요청하지 않습니다.

## 보호와 한계

- 컨테이너·모든 볼륨 삭제, 패키지 삭제, 임의 파일 삭제, 강제 프로세스 종료, 메모리 캐시 강제 비우기와 스왑 끄기를 제공하지 않습니다.
- 프로그램 CPU는 전체 코어 대비 값이고 컨테이너 CPU는 Docker 기준(100%=한 코어)입니다. 프로그램 메모리는 RSS 합계여서 공유 메모리가 중복될 수 있습니다. 전체 메모리 수치와 합산하지 않습니다.
- 다른 사용자, 핵심 시스템, Paseo/코딩 에이전트와 자식 프로세스를 보호합니다. 정상 종료 요청은 저장하지 않은 작업에 영향을 줄 수 있으며 프로그램이 거부할 수 있습니다. 컨테이너는 Docker 탭에서 제어합니다.
- 썸네일은 사용자 소유의 30일 이상 된 `.cache/thumbnails` PNG만 대상입니다. 링크·열린 파일·불완전한 접근 확인은 정리하지 않습니다. 개인 문서·코드·설정·인증 파일은 용량 분석만 제공합니다.
- Docker는 로컬 Unix 소켓만 사용하고 접속 정보·그룹·소켓 권한을 자동 변경하지 않습니다. 실행·중지 컨테이너와 Compose 파일의 참조, 보호 목록을 재검사합니다. 미확인 Compose가 있으면 이미지·네트워크 정리를 차단합니다. 다운로드 출처를 확인할 수 없는 로컬 이미지와 여러 태그를 가진 이미지도 보호합니다.
- 기본 Docker builder의 30일 이상 미사용 캐시만 대상으로 하고 5GB를 보존합니다. 로컬 기본 builder임을 확인하지 못하면 중지합니다. 원격 builder·배포·새 스택 생성은 지원하지 않습니다.
- 이미지 전체 공간은 Docker의 공유 레이어 집계입니다. 고유 레이어를 조회하지 못하면 미조회로 표시하고 개별 이미지 크기를 더해 회수 공간으로 단정하지 않습니다. 이력의 확보 용량은 실행 전후 파일시스템 여유 공간 증가량이며 다른 프로그램의 쓰기·삭제 영향이 섞일 수 있습니다.
- 파일시스템 분석은 낮은 우선순위로 수행하며 가상 영역·외부 파일시스템·Docker 저장소 내용을 제외합니다. 권한 거부와 90초 시간 제한은 일부 미조회로 표시합니다.
- 요청 로그·상태 파일에 환경 변수나 전체 프로세스 명령줄을 저장하지 않습니다. 컨테이너 로그는 요청한 최근 100줄(최대200줄), 64KB만 표시하고 알려진 인증 패턴·컨테이너 인증 환경 값은 숨깁니다. 임의의 로그에 포함된 모든 형태의 비밀을 자동으로 식별할 수는 없으므로 공유 전 확인해야 합니다.
- 모든 작업은 2분 미리보기에 연결하고 실행 전 상태를 다시 확인합니다. 변경된 대상은 건너뛰며 재시작 후 미완료 작업을 자동 재실행하지 않습니다. 현재 단계가 끝난 뒤 남은 단계를 취소할 수 있습니다.

## 저장·개발

상태는 `$PASEO_HOME/system-care/state.json`에 원자적으로 저장하며 디렉터리 0700, 파일 0600을 사용합니다. 사용자 설정과 작업 이력만 영구 저장하고 분석 결과·승인 미리보기·로그·비밀번호는 저장하지 않습니다.

```sh
npm ci --legacy-peer-deps --ignore-scripts
npm run typecheck
npm test
npm run test:helper
```

테스트는 임시 파일과 가짜 Docker/프로세스 실행기를 사용합니다. 실사용 컨테이너·볼륨·사용자 파일에 대한 파괴적 검증은 하지 않습니다. 관리자 도우미 테스트도 실제 APT·journal 정리 명령을 대역 처리합니다.

참고: [Paseo 플러그인](https://paseo.sh/docs/plugins), [Dockhand](https://dockhand.pro/manual/), [Docker 정리](https://docs.docker.com/engine/manage-resources/pruning/), [Polkit](https://polkit.pages.freedesktop.org/polkit/pkexec.1.html).
