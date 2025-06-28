// src/index.js
/**
 * هذا Worker يعمل كبروكسي ديناميكي لروابط الوسائط، مع دعم محسّن لإعادة كتابة روابط M3U8.
 * يتضمن الآن تقييد الوصول باستخدام مزيج من Origin و Referer.
 */

// **************************************************************************
// **** هذا هو النطاق المحدد الذي سيُسمح له بالوصول إلى البروكسي ****
// **************************************************************************
const ALLOWED_ORIGIN_OR_REFERER_HOST = 'https://14d4a19g-24ki1aqm-k4hk7m-ki2xm0-19xt1.blogspot.com'; 
// **************************************************************************


export default {
  async fetch(request) {
    const url = new URL(request.url);
    const targetUrlParam = url.searchParams.get('url');

    // --- جزء التحقق من النطاق المسموح به (مدمج ومرن) ---
    const requestOrigin = request.headers.get('Origin');
    const referer = request.headers.get('Referer');
    let isAllowed = false;

    // تحويل النطاق المسموح به ليتم مقارنته بدون البروتوكول أو المسار
    const allowedHost = new URL(ALLOWED_ORIGIN_OR_REFERER_HOST).hostname;

    // 1. التحقق من رأس Origin (الأكثر تفضيلاً)
    if (requestOrigin) {
        try {
            const originHost = new URL(requestOrigin).hostname;
            if (originHost === allowedHost || originHost.endsWith(`.${allowedHost}`)) {
                isAllowed = true;
            }
        } catch (e) {
            // Origin غير صالح، تجاهله
        }
    }

    // 2. إذا لم يكن مسموحًا بعد، تحقق من رأس Referer (كخيار احتياطي)
    if (!isAllowed && referer) {
        try {
            const refererUrl = new URL(referer);
            const refererHost = refererUrl.hostname;
            if (refererHost === allowedHost || refererHost.endsWith(`.${allowedHost}`)) {
                isAllowed = true;
            }
        } catch (e) {
            // Referer غير صالح، تجاهله
        }
    }

    // 3. رفض الطلبات إذا لم يتم التحقق من Origin أو Referer
    if (!isAllowed) {
        return new Response('Access Denied: This proxy can only be used from a specific domain.', {
            status: 403,
            headers: { 'Content-Type': 'text/plain' },
            'Access-Control-Allow-Origin': '*', // مهم للسماح للمتصفح برؤية رسالة الخطأ
        });
    }
    // --- نهاية جزء التحقق من النطاق المسموح به ---


    if (!targetUrlParam) {
      return new Response('Error: Missing "url" parameter. Usage: /?url=YOUR_TARGET_URL', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    let targetUrl;
    try {
      targetUrl = new URL(targetUrlParam);
    } catch (e) {
      return new Response('Error: Invalid "url" parameter provided.', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    console.log(`Proxying request to: ${targetUrl.href}`);

    try {
      const headers = new Headers(request.headers);
      headers.set('Host', targetUrl.hostname);
      // حذف رؤوس Cloudflare الخاصة التي قد تكشف أن الطلب يأتي من Worker
      headers.delete('X-Forwarded-For');
      headers.delete('X-Real-IP');
      headers.delete('CF-Connecting-IP');
      // إزالة Accept-Encoding لتجنب مشاكل فك الضغط في المتصفح إذا لم يتم التعامل معها بواسطة Worker
      headers.delete('Accept-Encoding'); 
      // بعض الخوادم قد تحظر الطلبات من User-Agent عام للعمال. يمكنك محاولة تعيين User-Agent محدد هنا
      headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');


      const response = await fetch(targetUrl.href, {
        method: request.method,
        headers: headers,
        body: request.body,
        redirect: 'follow',
        // تعطيل التخزين المؤقت تمامًا هنا لضمان تدفق مباشر للمحتوى
        cf: {
          cacheEverything: false,
          cacheTtl: 0,
        },
      });

      const newResponse = new Response(response.body, response);
      const contentType = response.headers.get('Content-Type');

      if (contentType) {
        newResponse.headers.set('Content-Type', contentType);
      }

      // إضافة رؤوس CORS للسماح للمتصفح بالوصول
      newResponse.headers.set('Access-Control-Allow-Origin', '*'); 
      newResponse.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
      newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Range, Authorization, Origin, Referer, User-Agent');
      newResponse.headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, X-Content-Type-Options, ETag, Link');


      // معالجة ملفات M3U8 لإعادة كتابة المسارات الداخلية عبر البروكسي
      if (contentType && (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegURL'))) {
        const text = await response.text();
        // بناء URL الأساسي للـ Worker نفسه لربط المسارات الداخلية
        const workerBaseUrl = `https://${url.hostname}${url.pathname}`; 

        const rewrittenText = text.split('\n').map(line => {
          // لا تقم بإعادة كتابة سطور EXT-X-STREAM-INF لأنها لا تشير إلى مسارات فعلية هنا
          if (line.startsWith('#EXT-X-STREAM-INF:')) {
            return line; 
          }

          // أعد كتابة المسارات النسبية أو المطلقة لملفات .ts أو ملفات M3U8 الفرعية
          if (line.trim().length > 0 && !line.startsWith('#')) {
            try {
              // حل المسار إلى URL مطلق بالنسبة لـ targetUrl (المصدر الأصلي)
              const resolvedUrl = new URL(line, targetUrl.href);
              // بناء URL الجديد الذي يمر عبر Worker
              const fullOriginalPath = `${resolvedUrl.protocol}//${resolvedUrl.hostname}${resolvedUrl.port ? `:${resolvedUrl.port}` : ''}${resolvedUrl.pathname}${resolvedUrl.search}`;

              return `${workerBaseUrl}?url=${encodeURIComponent(fullOriginalPath)}`;

            } catch (e) {
              console.warn(`Failed to parse URL in M3U8: ${line}`, e);
              return line; 
            }
          }
          return line; 
        }).join('\n');

        return new Response(rewrittenText, {
          headers: newResponse.headers,
          status: newResponse.status,
          statusText: newResponse.statusText
        }); 
      }

      return newResponse; 
    } catch (error) {
      console.error(`Proxy Error (Worker): ${error.message}`);
      return new Response(`Proxy Error: Could not reach target or process request - ${error.message}`, { status: 500 });
    }
  },
};