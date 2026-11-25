cmake_minimum_required(VERSION 3.28...3.30)

include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/common/bootstrap.cmake" NO_POLICY_SCOPE)

project(${_name} VERSION ${_version})

option(ENABLE_FRONTEND_API "Use obs-frontend-api for UI functionality" ON)
option(ENABLE_QT "Use Qt functionality" ON)

include(compilerconfig)
include(defaults)
include(helpers)

add_library(${CMAKE_PROJECT_NAME} MODULE)

set(YOUTUBE_CLIENT_ID "$ENV{YOUTUBE_CLIENT_ID}" CACHE STRING "Google Desktop OAuth client ID")
set(YOUTUBE_CLIENT_SECRET "$ENV{YOUTUBE_CLIENT_SECRET}" CACHE STRING "Google Desktop OAuth client secret")
configure_file(src/youtube-client.hpp.in generated/youtube-client.hpp @ONLY)
target_include_directories(${CMAKE_PROJECT_NAME} PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/generated")

find_package(libobs REQUIRED)
target_link_libraries(${CMAKE_PROJECT_NAME} PRIVATE OBS::libobs)

if(ENABLE_FRONTEND_API)
  find_package(obs-frontend-api REQUIRED)
  target_link_libraries(${CMAKE_PROJECT_NAME} PRIVATE OBS::obs-frontend-api)
endif()

if(ENABLE_QT)
  find_package(Qt6 COMPONENTS Widgets Core Network)
  target_link_libraries(${CMAKE_PROJECT_NAME} PRIVATE Qt6::Core Qt6::Widgets Qt6::Network)
  target_compile_options(
    ${CMAKE_PROJECT_NAME}
    PRIVATE $<$<C_COMPILER_ID:Clang,AppleClang>:-Wno-quoted-include-in-framework-header -Wno-comma>
  )
  set_target_properties(
    ${CMAKE_PROJECT_NAME}
    PROPERTIES AUTOMOC ON AUTOUIC ON AUTORCC ON
  )
endif()

# libcurl uploads clips. The plugin writes MP4s itself (src/memory-mux.cpp)
# and doesn't link FFmpeg, whose version changes between OBS releases.
find_package(CURL REQUIRED)
target_link_libraries(${CMAKE_PROJECT_NAME} PRIVATE CURL::libcurl)

target_sources(
  ${CMAKE_PROJECT_NAME}
  PRIVATE
    src/app-upload.cpp
    src/memory-mux.cpp
    src/plugin-main.cpp
    src/replay-output.cpp
    src/s3-upload.cpp
    src/save-dock.cpp
    src/settings-dialog.cpp
    src/sha256.cpp
    src/uploader.cpp
    src/youtube-upload.cpp
    src/youtube-connect.cpp
    src/focused-app.cpp
)

# The focused app's name, for clip categories.
if(APPLE)
  target_link_libraries(${CMAKE_PROJECT_NAME} PRIVATE "-framework CoreGraphics")
elseif(WIN32)
  target_link_libraries(${CMAKE_PROJECT_NAME} PRIVATE version)
endif()

set_target_properties_plugin(${CMAKE_PROJECT_NAME} PROPERTIES OUTPUT_NAME ${_name})
