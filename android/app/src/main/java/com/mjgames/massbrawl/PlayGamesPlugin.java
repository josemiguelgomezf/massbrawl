package com.mjgames.massbrawl;

import android.content.Intent;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.games.PlayGames;
import com.google.android.gms.tasks.Task;

/** Puente con Google Play Games Services v2. Todo error rechaza la promesa: nunca debe cerrar la app. */
@CapacitorPlugin(name = "PlayGames")
public class PlayGamesPlugin extends Plugin {

    @PluginMethod
    public void isAuthenticated(PluginCall call) {
        attempt(call, "isAuthenticated", () -> PlayGames.getGamesSignInClient(getActivity())
            .isAuthenticated()
            // Sin sesión o sin conexión no es un error: el juego sigue igual.
            .addOnCompleteListener(task -> resolveAuthentication(call, task.isSuccessful() && task.getResult().isAuthenticated())));
    }

    @PluginMethod
    public void signIn(PluginCall call) {
        attempt(call, "signIn", () -> PlayGames.getGamesSignInClient(getActivity())
            .signIn()
            .addOnSuccessListener(result -> resolveAuthentication(call, result.isAuthenticated()))
            .addOnFailureListener(e -> fail(call, "signIn", e)));
    }

    @PluginMethod
    public void unlockAchievement(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) {
            call.reject("Play Games: unlockAchievement requires id");
            return;
        }
        attempt(call, "unlockAchievement", () -> PlayGames.getAchievementsClient(getActivity())
            .unlockImmediate(id)
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(e -> fail(call, "unlockAchievement", e)));
    }

    @PluginMethod
    public void submitScore(PluginCall call) {
        String leaderboardId = call.getString("leaderboardId");
        // call.getLong solo acepta valores Long; un número pequeño llega del JSON como Integer.
        long score = call.getData().optLong("score", -1);
        if (leaderboardId == null || leaderboardId.isEmpty() || score < 0) {
            call.reject("Play Games: submitScore requires leaderboardId and score");
            return;
        }
        attempt(call, "submitScore", () -> PlayGames.getLeaderboardsClient(getActivity())
            .submitScoreImmediate(leaderboardId, score)
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(e -> fail(call, "submitScore", e)));
    }

    @PluginMethod
    public void showAchievements(PluginCall call) {
        attempt(call, "showAchievements", () -> openScreen(call, "showAchievements", PlayGames.getAchievementsClient(getActivity()).getAchievementsIntent()));
    }

    @PluginMethod
    public void showLeaderboard(PluginCall call) {
        String leaderboardId = call.getString("leaderboardId");
        if (leaderboardId == null || leaderboardId.isEmpty()) {
            call.reject("Play Games: showLeaderboard requires leaderboardId");
            return;
        }
        attempt(call, "showLeaderboard", () -> openScreen(call, "showLeaderboard", PlayGames.getLeaderboardsClient(getActivity()).getLeaderboardIntent(leaderboardId)));
    }

    // La documentación exige abrir estas pantallas "for result", aunque no devuelven nada.
    private void openScreen(PluginCall call, String method, Task<Intent> intentTask) {
        intentTask
            .addOnSuccessListener(intent -> attempt(call, method, () -> startActivityForResult(call, intent, "onScreenClosed")))
            .addOnFailureListener(e -> fail(call, method, e));
    }

    @ActivityCallback
    private void onScreenClosed(PluginCall call, ActivityResult result) {
        if (call != null) call.resolve();
    }

    private void resolveAuthentication(PluginCall call, boolean authenticated) {
        JSObject result = new JSObject();
        result.put("authenticated", authenticated);
        call.resolve(result);
    }

    // Una excepción sin capturar en un método de plugin o en un listener cerraría la app.
    private void attempt(PluginCall call, String method, Runnable action) {
        try {
            action.run();
        } catch (Exception e) {
            fail(call, method, e);
        }
    }

    private void fail(PluginCall call, String method, Exception e) {
        call.reject("Play Games: " + method + " failed: " + e.getMessage(), e);
    }
}
