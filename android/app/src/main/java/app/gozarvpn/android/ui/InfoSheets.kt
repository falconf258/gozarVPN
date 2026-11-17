package app.gozarvpn.android.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** One donation address. An empty [address] shows "coming soon" and no copy button. */
data class Wallet(val coin: String, val network: String, val address: String)

/** Paste the addresses here; nothing else needs to change. */
val WALLETS = listOf(
    Wallet("USDT", "TRC20 (Tron)", ""),
    Wallet("TON", "TON", ""),
    Wallet("BTC", "Bitcoin", ""),
    Wallet("ETH", "Ethereum (ERC20)", ""),
)

private const val PRIVACY_FA = """
خلاصه: GozarVpn حساب کاربری و ثبت‌نام ندارد و هیچ آمار، تبلیغ یا ردیابی‌ای داخلش نیست. سازنده‌ی برنامه سروری ندارد و هیچ اطلاعاتی از شما، کانفیگ‌هایتان یا سایت‌هایی که باز می‌کنید به دستش نمی‌رسد.

چه چیزهایی روی گوشی خودتان می‌ماند
• کانفیگ‌ها، ساب‌ها، تنظیمات و فهرست برنامه‌هایی که انتخاب کرده‌اید فقط روی همین گوشی ذخیره می‌شوند.
• نام کاربری و رمز OpenVPN رمزنگاری‌شده نگه داشته می‌شود.
• لاگ فقط در حافظه است و با بستن برنامه پاک می‌شود، مگر خودتان کپی‌اش کنید.

برنامه خودش به کجاها وصل می‌شود
• سرورهایی که خودتان انتخاب کرده‌اید و شبکه‌ی موتوری که روشن است (WARP کلودفلر، Tor، سایفون یا OpenVPN).
• تست پینگ و سالم بودن تونل: یک درخواست خیلی کوچک به گوگل یا کلودفلر، از داخل همان تونل.
• نشان دادن IP و کشور خروجی: صفحه‌ی trace کلودفلر، از داخل تونل.
• لینک سابی که خودتان اضافه کرده‌اید، برای گرفتن و به‌روز کردن کانفیگ‌ها.
• ساخت WARP رایگان: فقط وقتی دکمه‌اش را بزنید، یک اکانت WARP از کلودفلر گرفته می‌شود.
• پیدا کردن نسخه‌ی جدید: صفحه‌ی Releaseهای همین پروژه در GitHub. اگر نمی‌خواهید، «بررسی خودکار» را در بیشتر › به‌روزرسانی برنامه خاموش کنید.
• پل‌های تازه‌ی Tor (از GitHub) وقتی موتور Tor به پل نیاز دارد، و قوانین ایران (از jsDelivr) فقط وقتی دکمه‌ی به‌روزرسانی‌اش را بزنید.
در هیچ‌کدام از این درخواست‌ها چیزی درباره‌ی شما یا کانفیگ‌هایتان فرستاده نمی‌شود.

مجوزهایی که برنامه از اندروید می‌گیرد
• VPN: کار اصلی برنامه همین است. اندروید یک بار از خودتان اجازه می‌گیرد.
• سرویس پیش‌زمینه و اعلان: تا VPN روشن بماند و وضعیتش را در اعلان ببینید.
• اینترنت و وضعیت شبکه: برای وصل شدن و فهمیدن اینکه وای‌فای یا دیتا عوض شده.
• دیدن فهرست برنامه‌ها: فقط برای انتخاب برنامه‌ها در «تونل‌سازی انتخابی» و «همیشه مستقیم». این فهرست از گوشی بیرون نمی‌رود.
• دسترسی استفاده (Usage access): فقط اگر «توقف خودکار» را روشن کنید و خودتان در تنظیمات اجازه بدهید، تا بفهمد کدام برنامه باز است.
• نصب برنامه: فقط برای نصب نسخه‌ی جدیدی که خودتان دانلود کرده‌اید.
برنامه به موقعیت مکانی، مخاطبین، عکس‌ها و فایل‌ها، دوربین و میکروفون دسترسی ندارد.

کد برنامه
کد کامل GozarVpn با مجوز AGPL در github.com/falconf258/gozarVPN منتشر شده و هر کسی می‌تواند همه‌ی این‌ها را خودش بررسی کند.
"""

private const val PRIVACY_EN = """
In short: GozarVpn has no account and no sign-up, and contains no analytics, ads or tracking. The developer runs no server and receives nothing about you, your configs or the sites you visit.

What stays on your phone
• Your configs, subscriptions, settings and app lists are stored only on this phone.
• OpenVPN usernames and passwords are kept encrypted.
• The log lives in memory only and is gone when the app closes, unless you copy it.

Where the app itself connects
• The servers you picked, and the network of the engine you turned on (Cloudflare WARP, Tor, Psiphon or OpenVPN).
• Ping and tunnel checks: one tiny request to Google or Cloudflare, through the tunnel.
• Showing your exit IP and country: Cloudflare's trace page, through the tunnel.
• Subscription links you added, to fetch and refresh their configs.
• Free WARP: only when you press its button, a WARP account is created at Cloudflare.
• New versions: this project's Releases page on GitHub. Turn off "check automatically" under More › App update if you don't want that.
• Fresh Tor bridges (from GitHub) when the Tor engine needs them, and Iran rules (from jsDelivr) only when you press their update button.
None of these requests send anything about you or your configs.

Android permissions
• VPN: the whole point of the app. Android asks you once.
• Foreground service and notifications: keeps the VPN running and shows its status.
• Internet and network state: to connect and notice when Wi-Fi or mobile data changes.
• List of installed apps: only to pick apps for split tunnelling and "always direct". The list never leaves the phone.
• Usage access: only if you turn on auto-pause and allow it yourself in Settings, so the app knows which app is open.
• Install apps: only to install an update you downloaded.
The app has no access to your location, contacts, photos and files, camera or microphone.

Source code
GozarVpn is open source (AGPL) at github.com/falconf258/gozarVPN, so anyone can check all of this.
"""

@Composable
fun PrivacyDialog(onClose: () -> Unit) {
    var english by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(if (english) "Privacy" else "حریم خصوصی") },
        text = {
            Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState())) {
                val body = (if (english) PRIVACY_EN else PRIVACY_FA).trim()
                if (english) {
                    androidx.compose.runtime.CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                        Text(body, fontSize = 13.sp, lineHeight = 20.sp, modifier = Modifier.fillMaxWidth())
                    }
                } else Text(body, fontSize = 13.sp, lineHeight = 21.sp)
            }
        },
        confirmButton = { TextButton(onClose) { Text(if (english) "Close" else "بستن") } },
        dismissButton = { TextButton({ english = !english }) { Text(if (english) "فارسی" else "English") } },
    )
}

@Composable
fun DonateDialog(onClose: () -> Unit) {
    val ctx = LocalContext.current
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("حمایت از سازنده") },
        text = {
            Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "اگر GozarVpn به کارتان آمده و دوست دارید حمایت کنید، می‌توانید به یکی از این آدرس‌ها رمزارز بفرستید. حمایت کاملاً اختیاری است و هیچ بخشی از برنامه به آن بستگی ندارد.\n\n" +
                        "قبل از ارسال، شبکه را با دقت انتخاب کنید. ارسال روی شبکه‌ی اشتباه برگشت ندارد.",
                    fontSize = 13.sp, lineHeight = 21.sp,
                )
                for (w in WALLETS) {
                    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("${w.coin} · ${w.network}", fontWeight = FontWeight.Bold, fontSize = 13.sp, modifier = Modifier.weight(1f))
                            if (w.address.isNotBlank()) TextButton({
                                (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText(w.coin, w.address))
                                Toast.makeText(ctx, "آدرس ${w.coin} کپی شد", Toast.LENGTH_SHORT).show()
                            }) { Text("کپی") }
                        }
                        if (w.address.isBlank()) Text("به‌زودی", color = Muted, fontSize = 12.sp)
                        else Text(w.address, fontFamily = FontFamily.Monospace, fontSize = 11.5.sp, color = Muted)
                    }
                }
                Text("If GozarVpn helps you, you can support it with crypto. It is completely optional and changes nothing in the app.", color = Muted, fontSize = 11.5.sp)
            }
        },
        confirmButton = { TextButton(onClose) { Text("بستن") } },
    )
}
