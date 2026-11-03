/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

#pragma once

class HttpServer;
class AppSettings;

/// The admin page's "Apps on this PC" (AppSettings::hostApps), every route
/// the host administrator's alone (HttpRequest::isLocal) — a command runs as
/// this desktop's user:
///   GET    /api/host-apps               {supported, max, screen, apps, detected}
///   POST   /api/host-apps               {apps: [{id?, name, command}]} — the whole list
///   POST   /api/host-apps/restore       {source} — a launcher's card removed earlier
///   POST   /api/host-apps/:id/image     {png: <base64>}
///   DELETE /api/host-apps/:id/image
void registerHostAppRoutes(HttpServer& server, AppSettings& appSettings);

/// Gives each launcher found on this PC (LauncherDetect) its card, with its
/// program's icon for an image, once per version of this app: called at the
/// server's start, the first one after an install or an update seeds.
void seedDetectedLaunchers(AppSettings& appSettings);
