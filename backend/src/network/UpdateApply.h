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

/**
 * @brief The `--update-apply` mode: the elevated half of the Update button on
 * Windows, the action of the installer's "MoonlightWeb Update" task.
 *
 * The task runs elevated without a prompt (RunLevel=HighestAvailable, started
 * by the unprivileged server with `schtasks /Run`). It used to run the staged
 * installer under %LocalAppData% directly — a file the user's own unelevated
 * processes can write, so any of them could drop an executable there, start
 * the task and have it run elevated. Its action is now our exe under {app},
 * which trusts nothing the user can write:
 *
 *   1. copy the staged installer into {app}\update-staging, recreated empty
 *      with a DACL that only Administrators and SYSTEM can open;
 *   2. ask api.github.com — URL compiled in, TLS chain checked against the
 *      machine's roots only — what the latest release's installer is, and
 *      refuse unless it is strictly newer than this build (UpdateApplyRules);
 *   3. compare the copy's size and sha256 to GitHub's;
 *   4. when this install is Authenticode-signed, also require the copy to be
 *      signed (machine roots only) by the same subject;
 *   5. run the copy silently, from that directory, with a minimal environment
 *      whose TEMP is that directory too, and exit at once — the installer
 *      replaces this very exe.
 *
 * Any doubt at any step, and nothing runs. Exit code 0 once the installer is
 * started, 1 otherwise; the account is {app}\update-staging\update-apply.log.
 */
namespace UpdateApply {

int run();

} // namespace UpdateApply
