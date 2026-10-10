---
name: Home Finder
description: Finder 스타일의 Paseo 홈 폴더 탐색기
colors:
  selection-blue: "#006ddb"
  selection-text: "#ffffff"
  folder-blue: "#60baf0"
  folder-tab: "#389bd7"
  folder-edge: "#90d6ff"
  file-neutral: "#89939e"
typography:
  title:
    fontSize: "16px"
    fontWeight: 600
  body:
    fontSize: "13px"
  label:
    fontSize: "12px"
  preview:
    fontFamily: "monospace"
    fontSize: "11px"
    lineHeight: "18px"
rounded:
  control: "6px"
  field: "7px"
  tile: "8px"
spacing:
  tight: "6px"
  group: "10px"
  content: "16px"
  dialog: "22px"
components:
  selected-row:
    backgroundColor: "{colors.selection-blue}"
    textColor: "{colors.selection-text}"
    height: "34px"
  file-tile:
    rounded: "{rounded.tile}"
    width: "112px"
    height: "118px"
---
# Design System: Home Finder

## Overview

사용자가 지정한 Apple Finder를 시각적 기준으로 삼는다. 홈을 탐색하는 도구 화면이며, 실제 파일·선택·경로를 우선한다. OS 창 장식과 Paseo 바깥의 기능은 복제하지 않는다.

## Colors

선택과 즐겨찾기 아이콘은 파란색을 사용한다. 폴더는 세 가지 푸른 면으로 탭·본체·위쪽 경계를 구분한다. 배경, 툴바, 사이드바, 본문·보조 텍스트, 구분선은 호스트의 `theme.colors.surface0/1/2`, `foreground`, `foregroundMuted`, `border`에서 가져오며 고정 중립색을 새로 정의하지 않는다.

## Typography

본문과 조작은 호스트의 기본 서체를 계승한다. 제목 16px/600, 조작 13px, 파일 이름·보조 정보 12px. 텍스트 미리보기는 웹의 monospace, iOS의 Menlo 11px/18px이다. 긴 이름은 아이콘에서 두 줄, 목록·열에서 한 줄로 제한하고 정보 패널에서 전체 경로를 읽을 수 있다.

## Layout

지속적인 도구 막대, 204px 사이드바, 파일 영역, 선택적인 284px 정보 패널, 하단 경로·상태 막대를 사용한다. 아이콘은 가용 폭에 맞춘 120px 셀이다. 목록 행은 데스크톱 36px, 좁은 화면 46px이다. 아이콘·목록은 FlatList로 가상화한다. 열 보기는 최근 두 상위 폴더와 현재 폴더를 함께 유지한다.

`layout.compact`를 따르며 자체의 픽셀 브레이크포인트는 없다. 좁은 화면의 사이드바는 172px, 기본 접힘, 정보는 호스트 모달이다. 검색은 버튼으로 펼친다. 데스크톱은 한 줄 도구 막대이며, 좁은 화면의 보기 전환은 작업 메뉴, 다운로드·미리보기는 선택 상태 막대에 둔다.

## Elevation & Depth

화면은 호스트 중립 표면과 1px 구분선으로 나눈다. 장식용 유리 효과나 그림자는 없다. 모달의 위치·키보드·안전 영역·포커스는 Paseo SDK가 처리한다.

## Shapes

도구 6px, 검색 입력 7px, 아이콘 선택 표면 8px 모서리. 일반 파일 아이콘은 호스트 Lucide Icon이다. 폴더는 일관된 코드 도형이다.

## Components

단일 클릭은 선택, 두 번 클릭은 열기, Command/Control은 추가 선택, Shift는 범위 선택이다. 열에서 폴더는 단일 클릭으로 이동한다. 삭제는 확인 뒤 휴지통으로 이동한다. 우클릭·선택 작업 버튼·터치 길게 누르기를 함께 제공한다. 동작 중에는 해당 조작을 비활성화하며 실패 항목은 선택에 남는다. 토스트와 화면 오류에서 복구 방법을 안내한다.

## Do's and Don'ts

`.dev` 등 숨김 항목도 기본으로 표시하며 사용자가 보기 옵션에서 숨길 수 있다. 실제 항목과 경로만 표시한다. 파일마다 다른 장식 카드나 대시보드 수치를 만들지 않는다. 활성 선택 이외의 영역에 강한 색을 채우지 않는다. 홈 외부 접근, 무조건 덮어쓰기, 휴지통 비우기와 영구 삭제를 추가하지 않는다. OS Finder와 픽셀 단위 일치를 주장하지 않는다.

다운로드는 브라우저 URL로만 제공한다. 준비된 단일 파일은 즉시 브라우저를 열고, 여러 파일 또는 준비 중인 링크만 다운로드 목록에 표시한다. 앱 저장·공유·전송 방식 선택 UI는 넣지 않는다. 중복 항목 수·숨김 상태·상시 선택 도구를 없애고 파일 작업은 메뉴로 모은다.
