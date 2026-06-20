export async function onRequest(context) {
    const {
        request,
        env,
        params,
    } = context;

    const url = new URL(request.url);

    // 获取记录（支持短 ID 和长 ID）
    let record = await env.img_url.getWithMetadata(params.id);

    // 如果找不到，尝试去掉扩展名再查（兼容短 ID 格式）
    if (!record && params.id.includes('.')) {
        const idWithoutExt = params.id.split('.')[0];
        record = await env.img_url.getWithMetadata(idWithoutExt);
    }

    let fileId;
    let fileUrl;

    if (record && record.metadata && record.metadata.originalId) {
        // 短 ID：使用原始 file_id 获取图片
        fileId = record.metadata.originalId;
        const filePath = await getFilePath(env, fileId);
        if (!filePath) {
            return new Response('Not Found', { status: 404 });
        }
        fileUrl = `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`;
    } else if (url.pathname.length > 39) {
        // 旧的长 ID 直接访问（兼容旧链接）
        fileId = url.pathname.split(".")[0].split("/")[2];
        const filePath = await getFilePath(env, fileId);
        if (!filePath) {
            return new Response('Not Found', { status: 404 });
        }
        fileUrl = `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`;
    } else {
        // 尝试从 telegra.ph 直接获取（兼容原始链接）
        fileUrl = 'https://telegra.ph/' + url.pathname + url.search;
    }

    const response = await fetch(fileUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
    });

    // 关键修复：如果获取失败，返回 404 而不是假装是图片
    if (!response.ok) {
        console.error('Failed to fetch image:', response.status, fileUrl);
        return new Response('Image not found', { status: 404 });
    }

    console.log(response.ok, response.status);

    const isAdmin = request.headers.get('Referer')?.includes(`${url.origin}/admin`);
    if (isAdmin) {
        return makeInlineResponse(response, url);
    }

    if (!env.img_url) {
        console.log("KV storage not available, returning image directly");
        return makeInlineResponse(response, url);
    }

    // 如果 record 不存在（旧链接），初始化元数据
    if (!record || !record.metadata) {
        console.log("Metadata not found, initializing...");
        record = {
            metadata: {
                ListType: "None",
                Label: "None",
                TimeStamp: Date.now(),
                liked: false,
                fileName: params.id,
                fileSize: 0,
            }
        };
        await env.img_url.put(params.id, "", { metadata: record.metadata });
    }

    const metadata = {
        ListType: record.metadata.ListType || "None",
        Label: record.metadata.Label || "None",
        TimeStamp: record.metadata.TimeStamp || Date.now(),
        liked: record.metadata.liked !== undefined ? record.metadata.liked : false,
        fileName: record.metadata.fileName || params.id,
        fileSize: record.metadata.fileSize || 0,
    };

    if (metadata.ListType === "White") {
        return makeInlineResponse(response, url);
    } else if (metadata.ListType === "Block" || metadata.Label === "adult") {
        const referer = request.headers.get('Referer');
        const redirectUrl = referer ? "https://static-res.pages.dev/teleimage/img-block-compressed.png" : `${url.origin}/block-img.html`;
        return Response.redirect(redirectUrl, 302);
    }

    if (env.WhiteList_Mode === "true") {
        return Response.redirect(`${url.origin}/whitelist-on.html`, 302);
    }

    if (env.ModerateContentApiKey) {
        try {
            console.log("Starting content moderation...");
            const moderateUrl = `https://api.moderatecontent.com/moderate/?key=${env.ModerateContentApiKey}&url=https://telegra.ph${url.pathname}${url.search}`;
            const moderateResponse = await fetch(moderateUrl);

            if (!moderateResponse.ok) {
                console.error("Content moderation API request failed: " + moderateResponse.status);
            } else {
                const moderateData = await moderateResponse.json();
                console.log("Content moderation results:", moderateData);

                if (moderateData && moderateData.rating_label) {
                    metadata.Label = moderateData.rating_label;

                    if (moderateData.rating_label === "adult") {
                        console.log("Content marked as adult, saving metadata and redirecting");
                        await env.img_url.put(params.id, "", { metadata });
                        return Response.redirect(`${url.origin}/block-img.html`, 302);
                    }
                }
            }
        } catch (error) {
            console.error("Error during content moderation: " + error.message);
        }
    }

    console.log("Saving metadata");
    await env.img_url.put(params.id, "", { metadata });

    return makeInlineResponse(response, url);
}

function makeInlineResponse(response, requestUrl) {
    // 关键：创建全新的 Headers，不复制上游的任何头
    const newHeaders = new Headers();

    // 优先使用上游（Telegram）返回的 Content-Type，因为它更准确
    // Telegram 可能会转换图片格式（如 PNG→JPEG），URL 扩展名不一定正确
    const upstreamContentType = response.headers.get('Content-Type');
    if (upstreamContentType && upstreamContentType.startsWith('image/')) {
        newHeaders.set('Content-Type', upstreamContentType);
    } else {
        // 回退到根据 URL 扩展名推断
        const pathname = requestUrl.pathname || '';
        const ext = pathname.split('.').pop().toLowerCase();
        const mimeTypes = {
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'png': 'image/png',
            'gif': 'image/gif',
            'webp': 'image/webp',
            'svg': 'image/svg+xml',
            'bmp': 'image/bmp',
            'ico': 'image/x-icon',
        };
        newHeaders.set('Content-Type', mimeTypes[ext] || 'image/jpeg');
    }

    newHeaders.set('Content-Disposition', 'inline');
    newHeaders.set('Cache-Control', 'public, max-age=31536000');

    // 保留 content-length（如果有）
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
        newHeaders.set('Content-Length', contentLength);
    }

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
    });
}

async function getFilePath(env, file_id) {
    try {
        const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/getFile?file_id=${file_id}`;
        const res = await fetch(url, {
            method: 'GET',
        });

        if (!res.ok) {
            console.error(`HTTP error! status: ${res.status}`);
            return null;
        }

        const responseData = await res.json();
        const { ok, result } = responseData;

        if (ok && result) {
            return result.file_path;
        } else {
            console.error('Error in response data:', responseData);
            return null;
        }
    } catch (error) {
        console.error('Error fetching file path:', error.message);
        return null;
    }
}