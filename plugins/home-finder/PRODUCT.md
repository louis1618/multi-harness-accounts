# Home Finder
<!-- impeccable:product-schema 1 -->
## Platform
web
## Users
Paseo를 사용하는 홈 폴더 소유자. 원격 데스크톱·모바일에서 같은 호스트 파일을 관리한다.
## Product Purpose
Paseo 사이드바에서 호스트 사용자 홈 전체를 탐색하고 파일 작업을 완료한다.
## Operating Context
Paseo 0.10.0 플러그인 SDK, React Native 클라이언트와 Node 서버. 기존 계정 플러그인과 독립 설치.
## Capabilities and Constraints
파일·폴더 이름 변경, 다운로드, 다중 선택, 삭제, 즐겨찾기, 보기 변경. 홈 외부 링크를 통한 접근 차단. 실제 데이터 사용. 삭제는 복구 가능한 휴지통으로 구현한다(사용자 응답이 없어 권장 기본값 적용). 한국어 UI는 기존 작업의 언어를 따른다.
## Brand Commitments
사용자가 지정한 Apple Finder UI/UX를 참조한다. OS Finder 앱 자체가 아닌 Paseo 플러그인이다.
## Product Principles
익숙한 파일 작업, 경로와 선택 상태의 명확함, 실패 시 데이터 보존.

## 기기 다운로드
다운로드는 브라우저 URL 방식만 사용한다. 버튼을 누른 기기의 브라우저가 저장하며, 앱 문서 저장 공간이나 공유창은 사용하지 않는다. 접근 가능한 VPN·네트워크 연결이 필요하다.
