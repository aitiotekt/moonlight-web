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

#include "HostAppImage.h"

#import <AppKit/AppKit.h>

namespace HostAppImage {

/// The icon Finder shows for @p path (an .app's own), drawn at @p size.
QImage macIconOf(const QString& path, int size)
{
    @autoreleasepool {
        NSString* file = path.toNSString();
        if (![[NSFileManager defaultManager] fileExistsAtPath:file]) return {};
        NSImage* icon = [[NSWorkspace sharedWorkspace] iconForFile:file];
        if (!icon) return {};
        NSRect rect = NSMakeRect(0, 0, size, size);
        CGImageRef cg = [icon CGImageForProposedRect:&rect context:nil hints:nil];
        if (!cg) return {};
        // Built without ARC (CMakeLists.txt): the pool releases it.
        NSBitmapImageRep* rep = [[[NSBitmapImageRep alloc] initWithCGImage:cg] autorelease];
        NSData* png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (!png) return {};
        QImage image;
        image.loadFromData(static_cast<const uchar*>(png.bytes), static_cast<int>(png.length),
                           "PNG");
        return image;
    }
}

} // namespace HostAppImage
